#!/bin/bash
# Export recent emails from Apple Mail as JSON
# Usage: ./scripts/get-mail.sh [hours]
# Default: last 24 hours from all inboxes

HOURS="${1:-24}"
OUTPUT_DIR="/Users/jonathanomahony/personal/nanoclaw/data/mail"
OUTPUT_FILE="${OUTPUT_DIR}/recent.json"
TEMP_FILE="${OUTPUT_DIR}/.raw_mail.txt"

mkdir -p "$OUTPUT_DIR"

# Use AppleScript to query Mail.app, output as delimited text
osascript -e "
tell application \"Mail\"
  set cutoffDate to (current date) - ($HOURS * 60 * 60)
  set resultLines to {}
  set allAccounts to every account
  repeat with acct in allAccounts
    try
      set inboxes to (every mailbox of acct whose name is \"INBOX\")
      repeat with mbox in inboxes
        set msgs to (every message of mbox whose date received > cutoffDate)
        repeat with msg in msgs
          try
            set msgSubject to subject of msg
            set msgSender to sender of msg
            set msgDate to date received of msg as string
            set msgRead to read status of msg
            set end of resultLines to msgSubject & \"|||\" & msgSender & \"|||\" & msgDate & \"|||\" & (msgRead as string)
          end try
        end repeat
      end repeat
    end try
  end repeat
  set AppleScript's text item delimiters to \"###\"
  return resultLines as text
end tell
" > "$TEMP_FILE" 2>/dev/null || echo "" > "$TEMP_FILE"

# Convert to JSON using python3
python3 -c "
import json, sys
from datetime import datetime

with open('$TEMP_FILE') as f:
    raw = f.read()

emails = []
if raw.strip():
    for entry in raw.split('###'):
        entry = entry.strip()
        if not entry:
            continue
        parts = entry.split('|||')
        if len(parts) >= 4:
            emails.append({
                'subject': parts[0].strip(),
                'from': parts[1].strip(),
                'date': parts[2].strip(),
                'read': parts[3].strip().lower() == 'true'
            })

output = {
    'fetched_at': datetime.now().isoformat(),
    'hours_covered': $HOURS,
    'count': len(emails),
    'emails': emails
}

with open('$OUTPUT_FILE', 'w') as f:
    json.dump(output, f, indent=2)

print(json.dumps(output, indent=2))
"

rm -f "$TEMP_FILE"
