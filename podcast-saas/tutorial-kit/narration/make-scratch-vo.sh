#!/bin/bash
# SCRATCH voiceover for timing/assembly work ONLY — macOS `say` (never ships).
# The real narration re-renders through run-narration.sh the moment a valid ElevenLabs
# key lands locally; file names are identical so the assembler swaps sources by directory.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p audio-scratch
node - <<'EOF'
const { execFileSync } = require('node:child_process');
const lines = require('./lines.json');
for (const l of lines) {
  const name = `f${l.film}-s${l.scene}`;
  const voice = l.role === 'viewer' ? 'Daniel' : 'Samantha';
  execFileSync('say', ['-v', voice, '-r', '170', '-o', `audio-scratch/${name}.aiff`, l.text]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `audio-scratch/${name}.aiff`,
    '-ar', '48000', '-b:a', '128k', `audio-scratch/${name}.mp3`]);
  execFileSync('rm', [`audio-scratch/${name}.aiff`]);
  console.log('scratch ✓', name);
}
EOF
echo "scratch VO complete — TIMING USE ONLY"
