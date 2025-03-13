#!/bin/bash

# Start Ollama service in the background
ollama serve &

# Wait for Ollama service to be ready
sleep 5

# Check if mistral model exists, if not pull it
if ! ollama list | grep -q "mistral"; then
    echo "Pulling Mistral model..."
    ollama pull mistral
fi

# Keep container running
tail -f /dev/null 