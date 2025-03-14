#!/bin/bash

# Start Ollama service in the background
ollama serve &

# Wait for Ollama service to be ready
sleep 5

# Pull the Mistral 7B model
echo "Pulling Mistral 7B model..."
ollama pull mistral:7b

# Keep container running
tail -f /dev/null 