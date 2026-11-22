#!/usr/bin/env bash
# Sync every repo of the signed-in GitHub account into the local atlas checkout dir,
# then rebuild the Hermes atlas. Idempotent: clones what is missing, fetches the rest.
set -u

REPOS_DIR="${HERMES_REPOS_DIR:-$HOME/hermes-repos}"
OWNER="${HERMES_GH_OWNER:-}"
PORT="${PORT:-4123}"
BASE="http://127.0.0.1:${PORT}"

command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
mkdir -p "$REPOS_DIR"

[ -n "$OWNER" ] || OWNER="$(gh api user --jq .login)"
echo "syncing repos for $OWNER into $REPOS_DIR"

mapfile -t REPOS < <(gh repo list "$OWNER" --limit 500 --json nameWithOwner --jq '.[].nameWithOwner')
printf '%s\n' "${REPOS[@]}" | sed 's#.*/##' > "$REPOS_DIR/.repos"

for full in "${REPOS[@]}"; do
  name="${full##*/}"
  dir="$REPOS_DIR/$name"
  if [ -d "$dir/.git" ]; then
    if git -C "$dir" fetch --quiet --depth 1 origin >/dev/null 2>&1; then
      asked="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
      git -C "$dir" reset --quiet --hard FETCH_HEAD >/dev/null 2>&1 || true
      echo "  updated $name (${asked})"
    else
      echo "  WARN could not fetch $name"
    fi
  else
    if git clone --quiet --depth 1 "https://github.com/$full.git" "$dir" 2>/dev/null; then
      echo "  cloned  $name"
    else
      echo "  WARN could not clone $full"
    fi
  fi
done

echo "repos on disk: $(find "$REPOS_DIR" -maxdepth 2 -name .git -type d | wc -l)"

if curl -fsS -X POST "$BASE/api/atlas/scan" -o /tmp/hermes-scan.json 2>/dev/null; then
  python3 -c "import json;d=json.load(open('/tmp/hermes-scan.json'));print('atlas rebuilt:',d['totals'],d['durationMs'],'ms')"
  echo "open $BASE/atlas.html"
else
  echo "bridge not reachable at $BASE — start it with: npm run ui, then press Rescan repos"
fi
