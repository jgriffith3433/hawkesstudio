@echo off
rem Deploys every Cloudflare Worker from its wrangler.jsonc (zone routes, never custom domains: docs/projects/AGENTS.md).
rem Safe to repeat: wrangler uploads the same code and the routes stay.
pushd C:\Projects\hawkesgen\server\gen-edge
call npx wrangler deploy || (popd & exit /b 1)
call npx wrangler deploy --env beta || (popd & exit /b 1)
popd
pushd C:\Projects\hawkesgen\server\gen-cdn
call npx wrangler deploy || (popd & exit /b 1)
popd
pushd C:\Projects\hawkesstudio\server\studio-edge
call npx wrangler deploy || (popd & exit /b 1)
call npx wrangler deploy --env beta || (popd & exit /b 1)
popd
pushd C:\Projects\hawkesstudio\server\beta-sites
call npx wrangler deploy || (popd & exit /b 1)
popd
