set -euo pipefail
cd "$(dirname "$0")/.."
npx esbuild test/integration.ts --bundle --platform=node --format=esm --target=node22 --outfile=.it.build.mjs --external:@prisma/client --external:pg --external:@electric-sql/pglite --external:@electric-sql/pglite-socket --external:@prisma/adapter-pg --tsconfig=tsconfig.json --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" --log-level=error
mv .it.build.mjs ./.it.mjs
node ./.it.mjs
rm -f ./.it.mjs
