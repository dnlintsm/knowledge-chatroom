#!/bin/bash
# Turns the walkthrough video Playwright recorded into a small GIF that a PR
# comment can show inline (GitHub comments can't embed .webm from a URL).
# Usage: scripts/preview-gif.sh [output.gif]
set -euo pipefail

OUT="${1:-preview/walkthrough.gif}"
VIDEO=$(find test-results -path '*walkthrough*' -name '*.webm' | head -n 1)

if [ -z "$VIDEO" ]; then
  echo "No walkthrough video found under test-results/" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
ffmpeg -y -loglevel error -i "$VIDEO" \
  -vf "fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer" \
  "$OUT"
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
