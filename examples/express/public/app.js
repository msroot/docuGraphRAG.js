// Global state for documents
let documents = [];
let selectedDocuments = new Set();

// Fetch and display documents
async function fetchDocuments() {
  try {
    const response = await fetch('/documents');
    const data = await response.json();
    documents = data;
    renderDocuments();
  } catch (error) {
    console.error('Error fetching documents:', error);
  }
}

// Render documents list
function renderDocuments() {
  const container = document.getElementById('documents');
  container.innerHTML = '';

  documents.forEach(doc => {
    const docElement = document.createElement('div');
    docElement.className = 'document-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'document-checkbox';
    checkbox.checked = selectedDocuments.has(doc.documentId);
    checkbox.addEventListener('change', () => toggleDocument(doc.documentId));

    const info = document.createElement('div');
    info.className = 'document-info';

    const name = document.createElement('div');
    name.className = 'document-name';
    name.textContent = doc.name || 'Untitled Document';

    const date = document.createElement('div');
    date.className = 'document-date';
    date.textContent = new Date(doc.created).toLocaleString();

    const status = document.createElement('div');
    status.className = 'document-status';
    status.textContent = '✓ Processed';

    info.appendChild(name);
    info.appendChild(date);

    docElement.appendChild(checkbox);
    docElement.appendChild(info);
    docElement.appendChild(status);

    container.appendChild(docElement);
  });

  // Enable/disable chat input based on selection
  const chatInput = document.getElementById('user-input');
  chatInput.disabled = selectedDocuments.size === 0;
}

// Toggle document selection
function toggleDocument(documentId) {
  if (selectedDocuments.has(documentId)) {
    selectedDocuments.delete(documentId);
  } else {
    selectedDocuments.add(documentId);
  }
  renderDocuments();
}

// Modified chat function to include selected documents
async function handleChat(question) {
  if (selectedDocuments.size === 0) {
    appendMessage('system', 'Please select at least one document to chat with.');
    return;
  }

  try {
    appendMessage('user', question);

    const response = await fetch('/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        question,
        documentIds: Array.from(selectedDocuments)
      })
    });

    const data = await response.json();

    if (data.error) {
      appendMessage('system', `Error: ${data.error}`);
      return;
    }

    appendMessage('assistant', data.answer);
  } catch (error) {
    console.error('Chat error:', error);
    appendMessage('system', 'An error occurred while processing your question.');
  }
}

// Handle file upload success
async function handleUploadSuccess(documentId) {
  await fetchDocuments();
  selectedDocuments.add(documentId);
  renderDocuments();
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  fetchDocuments();

  // Handle chat input
  const chatInput = document.getElementById('user-input');
  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const question = chatInput.value.trim();
      if (question) {
        handleChat(question);
        chatInput.value = '';
      }
    }
  });
});

async function sendMessage() {
  const messageInput = document.getElementById('user-input');
  const chatMessages = document.getElementById('chat-container');
  const question = messageInput.value.trim();

  if (!question) return;

  // Get selected document IDs
  const selectedDocuments = Array.from(document.querySelectorAll('.document-checkbox:checked'))
    .map(checkbox => checkbox.getAttribute('value'))
    .filter(id => id); // Filter out any null/undefined values

  if (selectedDocuments.length === 0) {
    alert('Please select at least one document');
    return;
  }

  // Clear input and disable it while processing
  messageInput.value = '';
  messageInput.disabled = true;

  try {
    // Add user message
    addMessageToChat('user', question);

    // Show thinking indicator
    document.getElementById('thinking-container').style.display = 'flex';

    // Send request to server
    const response = await fetch(`/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        question,
        documentIds: selectedDocuments
      })
    });

    // Hide thinking indicator
    document.getElementById('thinking-container').style.display = 'none';

    const data = await response.json();

    if (data.error) {
      addMessageToChat('system', `Error: ${data.error}`);
      return;
    }

    addMessageToChat('assistant', data.answer);
  } catch (error) {
    console.error('Chat error:', error);
    // Hide thinking indicator
    document.getElementById('thinking-container').style.display = 'none';
    addMessageToChat('system', 'An error occurred while processing your question.');
  } finally {
    // Re-enable input
    messageInput.disabled = false;
    messageInput.focus();
  }
} 