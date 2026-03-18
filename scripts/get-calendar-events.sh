#!/bin/bash
# Export calendar events as JSON for the agent
# Usage: ./scripts/get-calendar-events.sh [days]
# Default to 30 days to give full calendar access

DAYS="${1:-30}"
OUTPUT_DIR="/Users/jonathanomahony/personal/nanoclaw/data/calendar"
OUTPUT_FILE="${OUTPUT_DIR}/events.json"

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Get events for the next N days (default 30)
EVENTS=$(icalBuddy -f -nc -nrd "eventsToday+$DAYS" 2>/dev/null)

# If no events, output empty JSON
if [ -z "$EVENTS" ]; then
    cat > "$OUTPUT_FILE" << EOF
{
  "date": "$(date +%Y-%m-%d)",
  "fetched_at": "$(date -Iseconds)",
  "days_covered": $DAYS,
  "events": []
}
EOF
    exit 0
fi

# Parse events into JSON using Python
python3 << PYTHON
import json
import re
import subprocess
from datetime import datetime

events_text = '''$EVENTS'''

# Strip ANSI codes
ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
events_text = ansi_escape.sub('', events_text)

events = []
current_event = None

for line in events_text.split('\n'):
    line = line.strip()
    if not line:
        continue

    # New event starts with bullet
    if line.startswith('•'):
        if current_event:
            events.append(current_event)
        title = line.lstrip('• ').strip()
        current_event = {
            'id': f'evt-{len(events)}',
            'title': title,
            'time': '',
            'location': '',
            'notes': ''
        }
    elif current_event:
        if line.startswith('notes:'):
            # Notes can be multiline
            current_event['notes'] = line.replace('notes:', '').strip()
        elif line.startswith('attendees:'):
            pass  # Skip attendees for privacy
        elif not current_event['time'] and ('at' in line.lower() or 'tomorrow' in line.lower() or 'today' in line.lower()):
            current_event['time'] = line
        elif not current_event['location'] and ('http' in line or 'join' in line.lower()):
            current_event['location'] = line

if current_event:
    events.append(current_event)

output = {
    'date': datetime.now().strftime('%Y-%m-%d'),
    'fetched_at': datetime.now().isoformat(),
    'days_covered': $DAYS,
    'events': events
}

with open('$OUTPUT_FILE', 'w') as f:
    json.dump(output, f, indent=2)

print(json.dumps(output, indent=2))
PYTHON
