#!/usr/bin/env sh
# Construit dist/ et le publie sur la branche gh-pages (servie par GitHub Pages).
#   sh scripts/deploy-web.sh
set -e
cd "$(dirname "$0")/.."
node scripts/build-web.mjs
remote=$(git remote get-url origin)
cd dist
rm -rf .git
git init -q -b gh-pages
git add -A
git -c core.autocrlf=false commit -q -m "Publication $(date '+%Y-%m-%d %H:%M')"
git push -q -f "$remote" gh-pages
rm -rf .git
echo "Publié sur gh-pages"
