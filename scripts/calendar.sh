#!/bin/bash
# Calendar operations via icalBuddy and AppleScript
# Usage: ./scripts/calendar.sh <command> [args...]
#
# Commands:
#   list [days]                    - List events for next N days (default 30)
#   create <summary> <start> <end> [location] [notes] - Create event
#   search <query>                 - Search events by title
#   delete <event-id>              - Delete event by ID
#
# Date format for create: "YYYY-MM-DD HH:MM" or "YYYY-MM-DD HH:MM:SS"

set -e

COMMAND="${1:-list}"
shift || true

case "$COMMAND" in
  list)
    DAYS="${1:-30}"
    icalBuddy -f -nc -nrd "eventsToday+$DAYS" 2>/dev/null || echo "No events found"
    ;;

  create)
    if [ $# -lt 3 ]; then
      echo "Usage: calendar.sh create <summary> <start> <end> [location] [notes]"
      echo "Date format: YYYY-MM-DD HH:MM"
      exit 1
    fi
    SUMMARY="$1"
    START="$2"
    END="$3"
    LOCATION="${4:-}"
    NOTES="${5:-}"

    # Escape quotes for AppleScript
    SUMMARY=$(echo "$SUMMARY" | sed 's/"/\\"/g')
    LOCATION=$(echo "$LOCATION" | sed 's/"/\\"/g')
    NOTES=$(echo "$NOTES" | sed 's/"/\\"/g')

    osascript -e "
      tell application \"Calendar\"
        tell calendar \"Home\"
          make new event at end of events with properties ¬
            {summary:\"$SUMMARY\", start date:date \"$START\", end date:date \"$END\"$([ -n \"$LOCATION\" ] && echo ", location:\"$LOCATION\"")$([ -n \"$NOTES\" ] && echo ", description:\"$NOTES\"")}
        end tell
      end tell
    " 2>&1
    echo "Event created: $SUMMARY"
    ;;

  search)
    QUERY="$1"
    icalBuddy -f -nc eventsToday+30 2>/dev/null | grep -i "$QUERY" || echo "No matching events"
    ;;

  delete)
    # Note: icalBuddy doesn't support deletion directly
    # Would need to parse the event UID and use AppleScript
    echo "Delete not yet implemented - requires event UID"
    ;;

  *)
    echo "Unknown command: $COMMAND"
    echo "Commands: list, create, search, delete"
    exit 1
    ;;
esac
