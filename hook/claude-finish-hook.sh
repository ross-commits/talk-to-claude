#!/bin/bash

# Claude Code Finish Hook
# This hook is called when Claude Code completes a task
# It calls the user to inform them and ask what to do next

# Get the summary of what Claude did (passed as argument or from stdin)
SUMMARY="${1:-$(cat)}"

# Default message if no summary provided
if [ -z "$SUMMARY" ]; then
  SUMMARY="I've completed the tasks you assigned."
fi

# Call the user with the summary and ask what to do next
QUESTION="I've finished working on your project. Here's what I did: ${SUMMARY}. What would you like me to do next?"

# Execute hey-boss CLI
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR" && bun run src/cli.ts "$QUESTION"
