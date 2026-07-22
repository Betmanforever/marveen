#!/bin/bash
# Skill Index Generator
# Generates a Level 0 index of all available skills (name + description only)
# This keeps token usage low while making all skills discoverable

SKILLS_DIR="$HOME/.claude/skills"
OUTPUT="$SKILLS_DIR/.skill-index.md"

if [ ! -d "$SKILLS_DIR" ]; then
  echo "No skills directory found at $SKILLS_DIR"
  exit 0
fi

echo "# Skill Index (Level 0)" > "$OUTPUT"
echo "" >> "$OUTPUT"
echo "Ez az összes elérhető skill rövid indexe. Csak a nevet és leírást tartalmazza (Level 0)." >> "$OUTPUT"
echo "Ha egy skill releváns, olvasd be a teljes SKILL.md-t (Level 1)." >> "$OUTPUT"
echo "Ha segédfájlokra is szükség van, nézd meg a scripts/ és references/ mappákat (Level 2)." >> "$OUTPUT"
echo "" >> "$OUTPUT"
echo "| Skill | Leírás |" >> "$OUTPUT"
echo "|-------|--------|" >> "$OUTPUT"

SKILL_COUNT=0

for skill_dir in "$SKILLS_DIR"/*/; do
  [ -d "$skill_dir" ] || continue
  skill_md="$skill_dir/SKILL.md"
  [ -f "$skill_md" ] || continue

  # Extract name from frontmatter
  name=$(grep -m1 "^name:" "$skill_md" 2>/dev/null | sed 's/^name: *//' | tr -d '"' | tr -d "'")
  if [ -z "$name" ]; then
    name=$(basename "$skill_dir")
  fi

  # Extract description from frontmatter. Truncate at a WORD BOUNDARY within
  # 120 chars (+ ellipsis) so no index row ends mid-word (Gabor, 2026-07-22).
  desc=$(grep -m1 "^description:" "$skill_md" 2>/dev/null | sed 's/^description: *//' | tr -d '"' | tr -d "'" \
    | awk '{ if (length($0) <= 120) print; else { s = substr($0, 1, 120); sub(/ [^ ]*$/, "", s); print s "..." } }')
  if [ -z "$desc" ]; then
    desc="(nincs leírás)"
  fi

  echo "| \`$name\` | $desc |" >> "$OUTPUT"
  SKILL_COUNT=$((SKILL_COUNT + 1))
done

echo "" >> "$OUTPUT"
echo "_${SKILL_COUNT} skill indexelve. Generálva: $(date '+%Y-%m-%d %H:%M')_" >> "$OUTPUT"

echo "Skill index generated: $OUTPUT ($SKILL_COUNT skills)"
