import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';

export default {
  input: 'src/index.js',
  output: [
    {
      file: 'dist/index.cjs.js',
      format: 'cjs',
      sourcemap: true,
      inlineDynamicImports: true,
    },
    {
      file: 'dist/index.esm.js',
      format: 'esm',
      sourcemap: true,
      inlineDynamicImports: true,
    },
  ],
  plugins: [
    // 1. Informa ao Rollup para usar o campo "browser" nos package.json das dependências
    nodeResolve({
      browser: true,
    }),
    
    // 2. Converte módulos CommonJS para ESM
    commonjs(),

    // 3. Substitui variáveis de ambiente para remover código de debug e de servidor
    replace({
      preventAssignment: true,
      'process.env.NODE_ENV': JSON.stringify('production'),
    }),
  ],
};