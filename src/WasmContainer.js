import * as esbuild from 'esbuild-wasm';

/**
 * Trava de inicialização global, anexada ao objeto 'window' para ser persistente
 * entre recarregamentos de módulo (HMR) e o duplo render do React Strict Mode.
 */
if (typeof window !== 'undefined') {
  window.__ESBUILD_INITIALIZED__ = window.__ESBUILD_INITIALIZED__ || false;
}

export class WasmContainer {
    #fs = new Map();
    #importMap = { imports: {} };
    #resolver_unpack;
    
    constructor() {}

    /**
     * Inicializa o ambiente WASM de forma segura e idempotente.
     * @param {object} options - Opções de configuração.
     * @param {string} options.resolverJsUrl - URL pública para o seu arquivo 'resolver.js'.
     * @param {string} options.esbuildWasmUrl - URL pública para o arquivo 'esbuild.wasm'.
     * @returns {Promise<WasmContainer>} Uma instância pronta para uso do container.
     */
    static async boot(options) {
        if (!options || !options.resolverJsUrl || !options.esbuildWasmUrl) {
            throw new Error("As URLs 'resolverJsUrl' e 'esbuildWasmUrl' são obrigatórias.");
        }

        // Protege contra múltiplas inicializações no navegador
        if (typeof window !== 'undefined') {
            if (window.__ESBUILD_INITIALIZED__) {
            console.log('esbuild já inicializado');
            } else {
            await esbuild.initialize({ wasmURL: options.esbuildWasmUrl });
            window.__ESBUILD_INITIALIZED__ = true;
            console.log('esbuild inicializado agora');
            }
        }

        const dynamicImport = new Function('path', 'return import(path)');
        const resolverModule = await dynamicImport(options.resolverJsUrl);
        const initResolver = resolverModule.default;

        await initResolver();

        const container = new WasmContainer();
        container.#resolver_unpack = resolverModule.fetch_and_unpack_package;

        return container;
    }


    async mount(fileTree) {
        for (const [path, fileData] of Object.entries(fileTree)) {
            const fullPath = path.startsWith('/') ? path : `/${path}`;
            if (fileData.directory) { this.#fs.set(fullPath, { directory: {} }); this._writeTree(fileData.directory, fullPath); } 
            else { this.#fs.set(fullPath, fileData.file.contents); }
        }
    }

    _writeTree(tree, path) {
        for (const [name, value] of Object.entries(tree)) {
            const newPath = path ? `${path}/${name}` : `/${name}`;
            if (value.file) { this.#fs.set(newPath, value.file.contents); } 
            else if (value.directory) { this.#fs.set(newPath, { directory: {} }); this._writeTree(value.directory, newPath); }
        }
    }

    async readFile(path) {
        const content = this.#fs.get(path);
        if (content === undefined) throw new Error(`VFS: Arquivo não encontrado: ${path}`);
        return content;
    }

    async writeFile(path, content) {
        this.#fs.set(path, content);
    }

    async install() {
        const packageJson = JSON.parse(await this.readFile('/package.json'));
        const topLevelDependencies = Object.keys(packageJson.dependencies || {});
        this.#importMap = { imports: {} };
        const queue = [...topLevelDependencies];
        const processed = new Set();
        
        const resolveConditionalPath = (exportsValue) => {
            if (typeof exportsValue === 'string') return exportsValue;
            if (typeof exportsValue === 'object' && exportsValue !== null) {
                const priority = ['browser', 'import', 'default'];
                for (const condition of priority) {
                    if (exportsValue[condition]) {
                        const nestedPath = resolveConditionalPath(exportsValue[condition]);
                        if (nestedPath) return nestedPath;
                    }
                }
            }
            return null;
        };

        while (queue.length > 0) {
            const packageName = queue.shift();
            if (processed.has(packageName)) continue;
            console.log(`Instalando ${packageName}...`);
            try {
                const files = await this.#resolver_unpack(packageName);
                processed.add(packageName);
                for (const file of files) {
                    this.writeFile(`/node_modules/${packageName}/${file.path.replace(/^package\//, '')}`, file.content);
                }
                const depPackageJsonString = await this.readFile(`/node_modules/${packageName}/package.json`);
                const depPackageJson = JSON.parse(new TextDecoder().decode(depPackageJsonString));
                
                if (packageName === 'axios' && typeof depPackageJson.browser === 'string') {
                    const browserPath = depPackageJson.browser.startsWith('./') ? depPackageJson.browser.substring(2) : depPackageJson.browser;
                    this.#importMap.imports['axios'] = `/node_modules/axios/${browserPath}`;
                } else if (depPackageJson.exports) {
                    for (const [key, value] of Object.entries(depPackageJson.exports)) {
                        const resolvedPath = resolveConditionalPath(value);
                        if (!resolvedPath) continue;
                        const importKey = key === '.' ? packageName : `${packageName}/${key.replace('./', '')}`;
                        this.#importMap.imports[importKey] = `/node_modules/${packageName}/${resolvedPath.replace('./', '')}`;
                    }
                } else {
                    const mainFile = depPackageJson.module || depPackageJson.browser || depPackageJson.main || 'index.js';
                    this.#importMap.imports[packageName] = `/node_modules/${packageName}/${mainFile.replace('./', '')}`;
                }
                const transitiveDependencies = depPackageJson.dependencies || {};
                for (const depName of Object.keys(transitiveDependencies)) {
                    if (!processed.has(depName)) queue.push(depName);
                }
            } catch (err) {
                console.error(`Falha ao instalar o pacote ${packageName}:`, err);
            }
        }
        console.log("Final Import Map:", this.#importMap);
    }

    async bundle(entrypointPath) {
        const self = this;
        const vfsPlugin = {
            name: 'vfs-plugin',
            setup(build) {
                const nodeBuiltins = ['crypto', 'http', 'https', 'util', 'url', 'zlib', 'stream', 'events', 'assert', 'debug'];
                build.onResolve({ filter: new RegExp(`^(${nodeBuiltins.join('|')})$`) }, args => ({
                    path: args.path,
                    namespace: 'stub-node',
                }));
                build.onLoad({ filter: /.*/, namespace: 'stub-node' }, args => ({
                    contents: `
                        function EmptyClass() {}
                        export const Readable = EmptyClass;
                        export const Writable = EmptyClass;
                        export const EventEmitter = EmptyClass;
                        export default EmptyClass;
                    `,
                    loader: 'js',
                }));

                build.onResolve({ filter: /.*/ }, async (args) => {
                    const probeVFS = (path) => {
                        const potentialPaths = [path, `${path}.js`, `${path}.jsx`, `${path}/index.js`, `${path}/index.jsx`];
                        for (const p of potentialPaths) if (self.#fs.has(p)) return p;
                        return null;
                    };
                    let basePath;
                    if (args.path.startsWith('/') || args.path.startsWith('.')) {
                        basePath = new URL(args.path, 'file://' + args.importer).pathname;
                    } else if (self.#importMap.imports[args.path]) {
                        basePath = self.#importMap.imports[args.path];
                    } else {
                        return { errors: [{ text: `Não foi possível resolver '${args.path}'` }] };
                    }
                    const foundPath = probeVFS(basePath);
                    if (foundPath) return { path: foundPath, namespace: 'vfs' };
                    return { errors: [{ text: `VFS: Arquivo não encontrado: ${basePath}` }] };
                });

                build.onLoad({ filter: /.*/, namespace: 'vfs' }, async (args) => {
                    const contentsRaw = await self.readFile(args.path);
                    const contents = (contentsRaw instanceof Uint8Array) ? new TextDecoder().decode(contentsRaw) : contentsRaw;
                    let loaderType = 'jsx';
                    if (args.path.endsWith('.css')) loaderType = 'css';
                    return { contents, loader: loaderType };
                });
            },
        };

        const result = await esbuild.build({
            entryPoints: [entrypointPath],
            bundle: true,
            write: false,
            format: 'esm',
            platform: 'browser',
            plugins: [vfsPlugin],
        });
        return result.outputFiles[0].text;
    }
}