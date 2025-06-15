import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();
const app = express();
app.use(bodyParser.json());

// Configuration
const config = {
  PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  MODEL_ID: process.env.MODEL_ID || 'gemini-2.0-flash-exp',
  PORT: process.env.PORT || 10000,
  MEMORY_DURATION: 3600000, // 1 hour
  MAX_MESSAGE_LENGTH: 1800,
  TYPING_DELAY: 800,
  MEMORY_CLEANUP_INTERVAL: 300000, // 5 minutes
  MAX_MESSAGES_PER_USER: 10000,
  RATE_LIMIT_WINDOW: 60000, // 1 minute
  RATE_LIMIT_MAX: 30 // messages per minute
};

// In-memory storage
const greetedUsers = new Set();
const userSessions = new Map();
const rateLimiter = new Map();
const memoryFile = path.join(process.cwd(), 'memory.json');
let memory = {};

// Load memory from file
function loadMemory() {
  try {
    if (fs.existsSync(memoryFile)) {
      const data = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
      memory = data.memory || data; // Handle both old and new format
    }
  } catch (error) {
    console.error('Error loading memory:', error);
    memory = {};
  }
}

loadMemory();

// System prompt from the old version - clean and simple
const SYSTEM_PROMPT = `You are X.AI, a custom-built intelligent assistant developed by Darwin and powered by Google's Gemini 2.0 Flash model. 

Key facts about yourself (only mention when relevant or asked):
- Your name is X.AI
- You were created by Darwin
- You're powered by Google's Gemini 2.0 Flash model
- You work on Facebook Messenger, even on Facebook Free Mode (no load required)
- You provide cleaner, more flexible responses compared to Meta AI
- You have no ads or restrictions - just pure, direct assistance

Be natural and conversational. Only mention your identity when someone asks about you, wants to know who you are, or when it's contextually relevant. Don't constantly remind people of your name or creator unless they specifically ask.
Never send tables. Do not use Markdown, HTML, or code-based table formatting. Use bullet points or plain text lists instead.`;

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'X.AI server is running',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    activeUsers: Object.keys(memory).length,
    totalMessages: Object.values(memory).reduce((sum, msgs) => sum + msgs.length, 0)
  });
});

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === config.VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.error('Webhook verification failed');
    res.sendStatus(403);
  }
});

// Main webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    
    if (body.object !== 'page') {
      return res.sendStatus(404);
    }

    // Process all entries
    const promises = body.entry.map(entry => processEntry(entry).catch(error => {
      console.error('Error processing entry:', error);
    }));
    
    await Promise.all(promises);
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook handler error:', error);
    res.sendStatus(500);
  }
});

async function processEntry(entry) {
  const event = entry.messaging?.[0];
  if (!event || !event.sender?.id) return;

  const senderId = event.sender.id;

  // Initialize user session if needed
  if (!userSessions.has(senderId)) {
    userSessions.set(senderId, {
      name: null,
      lastActive: Date.now(),
      messageCount: 0,
      tone: 'neutral'
    });
  }

  // Rate limiting
  if (!checkRateLimit(senderId)) {
    await sendMessage(senderId, "You're sending messages too quickly. Please wait a moment before trying again.");
    return;
  }

  // Handle different event types
  if (event.message) {
    if (event.message.text) {
      await handleTextMessage(senderId, event.message.text);
    } else if (event.message.attachments) {
      await handleAttachment(senderId, event.message.attachments);
    }
  } else if (event.postback) {
    await handlePostback(senderId, event.postback);
  }
}

function checkRateLimit(senderId) {
  const now = Date.now();
  const userLimits = rateLimiter.get(senderId) || { count: 0, resetTime: now + config.RATE_LIMIT_WINDOW };
  
  if (now > userLimits.resetTime) {
    rateLimiter.set(senderId, { count: 1, resetTime: now + config.RATE_LIMIT_WINDOW });
    return true;
  }
  
  if (userLimits.count >= config.RATE_LIMIT_MAX) {
    return false;
  }
  
  userLimits.count++;
  rateLimiter.set(senderId, userLimits);
  return true;
}

async function handleTextMessage(senderId, text) {
  const userMessage = text.trim().toLowerCase();
  
  if (!userMessage) return;

  try {
    // Update user session
    const session = userSessions.get(senderId);
    session.lastActive = Date.now();
    session.messageCount++;

    await sendTyping(senderId, true);

    // Handle special commands
    if (await handleSpecialCommands(senderId, userMessage)) {
      await sendTyping(senderId, false);
      return;
    }

    // Handle new user greeting - using old version's cleaner approach
    if (!greetedUsers.has(senderId)) {
      await handleNewUser(senderId);
    }

    await processUserMessage(senderId, text);

  } catch (error) {
    console.error('Error handling text message:', error);
    await sendErrorRecovery(senderId, error);
  } finally {
    await sendTyping(senderId, false);
  }
}

async function handleSpecialCommands(senderId, message) {
  if (message === '/help' || message === 'help') {
    const helpText = 
      "Here's what I can help you with:\n\n" +
      "• Answer questions on any topic\n" +
      "• Explain complex concepts simply\n" +
      "• Help with writing and editing\n" +
      "• Provide analysis and insights\n" +
      "• Solve problems step by step\n" +
      "• Have natural conversations\n\n" +
      "Just ask me anything! I work best with clear, specific questions.";
    
    await sendMessage(senderId, helpText);
    return true;
  }
  
  if (message === '/about' || message === 'about') {
    const aboutText = 
      "I'm X.AI, your intelligent assistant.\n\n" +
      "Created by: Darwin\n" +
      "Powered by: Google's Gemini 2.0 Flash\n" +
      "Platform: Facebook Messenger\n\n" +
      "I provide clean, direct assistance without ads or restrictions. " +
      "I work even on Facebook Free Mode, so no data charges required!";
    
    await sendMessage(senderId, aboutText);
    return true;
  }
  
  if (message === '/reset' || message === 'reset conversation') {
    memory[senderId] = [];
    await sendMessage(senderId, "Our conversation has been reset. What would you like to talk about?");
    return true;
  }
  
  return false;
}

async function handleNewUser(senderId) {
  greetedUsers.add(senderId);
  
  // Using the old version's greeting - much cleaner
  const greeting = 
    `You're now chatting with X.AI — a custom-built intelligent assistant developed by Darwin and powered by Google's Gemini 2.0 Flash model.\n\n` +
    `Just like Meta AI, X.AI works even on Facebook Free Mode — no load required.\n\n` +
    `But here's the edge: X.AI isn't limited to Meta's filters. It gives you cleaner, more flexible responses, powered by the same kind of advanced tech you'd find in paid services.\n\n` +
    `No ads, no restrictions — just pure, direct assistance.`;
  
  await sendMessage(senderId, greeting);
}

async function handleAttachment(senderId, attachments) {
  let response = "I received your ";
  
  const types = attachments.map(att => {
    switch(att.type) {
      case 'image': return 'image';
      case 'video': return 'video';
      case 'audio': return 'audio file';
      case 'file': return 'document';
      default: return 'file';
    }
  });
  
  if (types.length === 1) {
    response += types[0];
  } else {
    response += types.slice(0, -1).join(', ') + ' and ' + types.slice(-1);
  }
  
  response += ".\n\n" +
    "Currently, I can only process text messages. You can describe what you want to know about the content, " +
    "or ask questions about the topic in text format instead.\n\n" +
    "What would you like to discuss?";
  
  await sendMessage(senderId, response);
}

async function handlePostback(senderId, postback) {
  const payload = postback.payload;
  
  switch(payload) {
    case 'GET_STARTED':
      await handleNewUser(senderId);
      break;
    case 'HELP':
      await handleSpecialCommands(senderId, '/help');
      break;
    case 'ABOUT':
      await handleSpecialCommands(senderId, '/about');
      break;
    default:
      await sendMessage(senderId, `You selected: ${payload}. How can I help you with that?`);
  }
}

async function processUserMessage(senderId, userText) {
  // Update memory
  updateUserMemory(senderId, userText);
  
  // Build conversation
  const conversation = buildConversation(senderId);
  
  // Get AI response
  const aiReply = await getAIResponse(conversation);
  
  if (aiReply) {
    saveAIResponse(senderId, aiReply);
    
    // Use the old version's clean formatting
    const formattedReply = clean(aiReply);
    await sendLongMessage(senderId, formattedReply);
  } else {
    await sendErrorRecovery(senderId, new Error('No AI response'));
  }
}

function updateUserMemory(senderId, text) {
  const now = Date.now();
  
  if (!memory[senderId]) {
    memory[senderId] = [];
  }
  
  // Clean old messages
  memory[senderId] = memory[senderId].filter(m => now - m.timestamp < config.MEMORY_DURATION);
  
  // Limit total messages per user
  if (memory[senderId].length >= config.MAX_MESSAGES_PER_USER) {
    memory[senderId] = memory[senderId].slice(-config.MAX_MESSAGES_PER_USER + 1);
  }
  
  memory[senderId].push({
    role: 'user',
    content: text,
    timestamp: now
  });
}

function saveAIResponse(senderId, response) {
  const now = Date.now();
  
  if (!memory[senderId]) {
    memory[senderId] = [];
  }
  
  memory[senderId].push({
    role: 'model',
    content: response,
    timestamp: now
  });
  
  saveMemoryToFile();
}

function buildConversation(senderId) {
  const conversation = [];
  
  // Always start with system prompt - from old version
  conversation.push({
    role: 'user',
    content: SYSTEM_PROMPT
  });
  
  conversation.push({
    role: 'model',
    content: 'Got it. I\'ll be helpful and natural in our conversation.'
  });

  // Add user conversation history
  const userMemory = memory[senderId] || [];
  userMemory.forEach(m => {
    conversation.push({
      role: m.role === 'assistant' ? 'model' : m.role,
      content: m.content
    });
  });

  return conversation;
}

async function getAIResponse(messages) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.MODEL_ID}:generateContent?key=${config.GEMINI_API_KEY}`,
      {
        contents: messages.map(msg => ({
          role: msg.role,
          parts: [{ text: msg.content }]
        }))
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    return response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  } catch (error) {
    console.error('Gemini API Error:', error.response?.data || error.message);
    return 'Sorry, I couldn\'t respond right now. Please try again!';
  }
}

async function sendErrorRecovery(senderId, error) {
  let errorMessage = "I encountered an issue processing that request. ";
  
  if (error.code === 'ECONNABORTED') {
    errorMessage = "The request took too long to process. ";
  } else if (error.response?.status === 429) {
    errorMessage = "I'm getting a lot of requests right now. Please wait a moment and try again.";
    await sendMessage(senderId, errorMessage);
    return;
  }
  
  errorMessage += "What else can I help you with?";
  await sendMessage(senderId, errorMessage);
}

async function sendMessage(recipientId, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${config.PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: { text }
      },
      { timeout: 10000 }
    );
  } catch (error) {
    console.error('Messenger API Error:', error.response?.data || error.message);
    throw error;
  }
}

// Using the old version's sendLongMessage - it's simpler and more reliable
async function sendLongMessage(recipientId, text) {
  const MAX_LENGTH = config.MAX_MESSAGE_LENGTH;
  
  if (text.length <= MAX_LENGTH) {
    await sendMessage(recipientId, text);
    return;
  }

  // Split text into chunks at natural break points
  const chunks = [];
  let currentChunk = '';
  
  const paragraphs = text.split('\n\n');
  
  for (const paragraph of paragraphs) {
    if ((currentChunk + paragraph + '\n\n').length <= MAX_LENGTH) {
      currentChunk += paragraph + '\n\n';
    } else {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      // If single paragraph is too long, split by sentences
      if (paragraph.length > MAX_LENGTH) {
        const sentences = paragraph.split('. ');
        for (const sentence of sentences) {
          if ((currentChunk + sentence + '. ').length <= MAX_LENGTH) {
            currentChunk += sentence + '. ';
          } else {
            if (currentChunk.trim()) {
              chunks.push(currentChunk.trim());
              currentChunk = '';
            }
            currentChunk = sentence + '. ';
          }
        }
      } else {
        currentChunk = paragraph + '\n\n';
      }
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // Send chunks with small delays
  for (let i = 0; i < chunks.length; i++) {
    await sendMessage(recipientId, chunks[i]);
    
    // Add typing indicator between chunks for natural feel
    if (i < chunks.length - 1) {
      await sleep(1000);
      await sendTyping(recipientId, true);
      await sleep(500);
      await sendTyping(recipientId, false);
    }
  }
}

async function sendTyping(recipientId, isOn) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${config.PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        sender_action: isOn ? 'typing_on' : 'typing_off'
      },
      { timeout: 5000 }
    );
  } catch (error) {
    console.error('Typing indicator error:', error.response?.data || error.message);
  }
}

// Using the old version's clean function - simple and effective
function clean(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')         // Remove bold markdown
    .replace(/\*(.*?)\*/g, '$1')             // Remove italic markdown
    .replace(/__(.*?)__/g, '$1')             // Remove underline
    .replace(/_(.*?)_/g, '$1')               // Remove italic (underscore)
    .replace(/~~(.*?)~~/g, '$1')             // Remove strikethrough
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')    // Remove inline code
    .replace(/(.*?)(.*?)/g, '$1')     // Remove markdown links
    .replace(/!(.*?)(.*?)/g, '')      // Remove image markdown
    .replace(/#+\s?(.*)/g, '\n\n$1')          // Line breaks before headers
    .replace(/>\s?(.*)/g, '$1')               // Remove blockquotes
    .replace(/^\s*[\*\-]\s+/gm, '- ')         // Replace bullets with dash
    .replace(/^\s*\d+\.\s+/gm, match => `\n${match.trim()} `) // Break before numbered
    .replace(/([^\n])\n(?=[A-Z])/g, '$1\n\n') // Extra spacing before new section
    .replace(/\n{3,}/g, '\n\n')               // Limit to 2 line breaks
    .replace(/[^\x00-\x7F]/g, '')             // Remove non-ASCII
    .trim();
}

function saveMemoryToFile() {
  try {
    const memoryData = {
      memory,
      timestamp: Date.now(),
      stats: {
        totalUsers: Object.keys(memory).length,
        totalMessages: Object.values(memory).reduce((sum, msgs) => sum + msgs.length, 0)
      }
    };
    fs.writeFileSync(memoryFile, JSON.stringify(memoryData, null, 2));
  } catch (error) {
    console.error('Error saving memory:', error);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Enhanced periodic cleanup
setInterval(() => {
  cleanupMemoryAndSessions();
}, config.MEMORY_CLEANUP_INTERVAL);

function cleanupMemoryAndSessions() {
  const now = Date.now();
  let cleaned = false;
  
  // Clean memory
  Object.keys(memory).forEach(userId => {
    const originalLength = memory[userId].length;
    memory[userId] = memory[userId].filter(m => now - m.timestamp < config.MEMORY_DURATION);
    
    if (memory[userId].length !== originalLength) {
      cleaned = true;
    }
    
    if (memory[userId].length === 0) {
      delete memory[userId];
      cleaned = true;
    }
  });
  
  // Clean inactive user sessions (24 hours)
  const sessionTimeout = 24 * 60 * 60 * 1000;
  for (const [userId, session] of userSessions.entries()) {
    if (now - session.lastActive > sessionTimeout) {
      userSessions.delete(userId);
      cleaned = true;
    }
  }
  
  // Clean rate limiter
  for (const [userId, limits] of rateLimiter.entries()) {
    if (now > limits.resetTime) {
      rateLimiter.delete(userId);
    }
  }
  
  if (cleaned) {
    saveMemoryToFile();
    console.log(`Memory cleanup completed. Active users: ${userSessions.size}, Memory entries: ${Object.keys(memory).length}`);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, saving data and shutting down...');
  saveMemoryToFile();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, saving data and shutting down...');
  saveMemoryToFile();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  saveMemoryToFile();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
app.listen(config.PORT, () => {
  console.log(`X.AI is running on port ${config.PORT}`);
  console.log(`Memory file: ${memoryFile}`);
  console.log(`Memory duration: ${config.MEMORY_DURATION / 1000 / 60} minutes`);
  console.log(`Rate limit: ${config.RATE_LIMIT_MAX} messages per minute`);
  console.log(`Max messages per user: ${config.MAX_MESSAGES_PER_USER}`);
});
