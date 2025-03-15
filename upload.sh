#!/bin/bash

# Example usage:
# ./upload.sh ./docs/story.pdf "Medical research paper" "Find all doctors and their research topics, identify relationships between researchers and their publications"

# Check if file path is provided
if [ -z "$1" ]; then
    echo "Usage: ./upload.sh <file_path> <document_description> <analysis_description>"
    echo ""
    echo "Example:"
    echo "./upload.sh ./docs/story.pdf \"Medical research paper\" \"Find all doctors and their research topics\""
    echo ""
    echo "Parameters:"
    echo "  <file_path>            : Path to the PDF file"
    echo "  <document_description> : Brief description of what the document is about"
    echo "  <analysis_description> : What entities and relationships to look for"
    exit 1
fi

FILE_PATH="$1"
DOC_DESCRIPTION="${2:-Document upload}"  # Brief description of the document
ANALYSIS_DESCRIPTION="${3:-Extract all named entities and their relationships}"  # What to analyze
SERVER_URL="http://localhost:3000"

# Check if file exists
if [ ! -f "$FILE_PATH" ]; then
    echo "Error: File not found: $FILE_PATH"
    exit 1
fi

echo "Uploading file: $FILE_PATH"
echo "Document description: $DOC_DESCRIPTION"
echo "Analysis request: $ANALYSIS_DESCRIPTION"

# Try to connect to server first
if ! curl --connect-timeout 1 -s "$SERVER_URL" > /dev/null; then
    echo "Error: Cannot connect to server at $SERVER_URL"
    echo "Please ensure the server is running and try again"
    exit 1
fi

# Upload using curl with correct field names
curl -X POST \
     -F "pdf=@$FILE_PATH" \
     -F "scenarioDescription=$DOC_DESCRIPTION" \
     -F "analysisDescription=$ANALYSIS_DESCRIPTION" \
     "$SERVER_URL/upload"

echo -e "\nUpload complete!" 