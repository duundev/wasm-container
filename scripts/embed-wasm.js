import fs from 'fs';
import path from 'path';

const assetsDir = path.resolve('assets');
const srcDir = path.resolve('src');
const outputFile = path.join(srcDir, 'wasm-assets.js');

try {
  const resolverJs = fs.readFileSync(path.join(assetsDir, 'resolver.js'), 'utf8');
  const resolverWasm = fs.readFileSync(path.join(assetsDir, 'resolver_bg.wasm'));
  const esbuildWasm = fs.readFileSync(path.join(assetsDir, 'esbuild.wasm'));

  const resolverJsBase64 = Buffer.from(resolverJs).toString('base64');
  const resolverWasmBase64 = resolverWasm.toString('base64');
  const esbuildWasmBase64 = esbuildWasm.toString('base64');

  const content = `// ARQUIVO GERADO AUTOMATICAMENTE! NÃO EDITE.
export const RESOLVER_JS_BASE64 = "${resolverJsBase64}";
export const RESOLVER_WASM_BASE64 = "${resolverWasmBase64}";
export const ESBUILD_WASM_BASE64 = "${esbuildWasmBase64}";
`;

  fs.writeFileSync(outputFile, content);
  console.log('✅ Ativos WASM embutidos com sucesso em src/wasm-assets.js');
} catch (error) {
  console.error('❌ Erro ao embutir os ativos WASM:', error);
  process.exit(1);
}