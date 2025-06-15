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
  TYPING_DELAY: 1500,
  MEMORY_CLEANUP_INTERVAL: 300000, // 5 minutes
  MAX_MESSAGES_PER_USER: 50,
  RATE_LIMIT_WINDOW: 60000, // 1 minute
  RATE_LIMIT_MAX: 10 // messages per minute
};

// In-memory storage
const greetedUsers = new Set();
const userSessions = new Map(); // Enhanced user data
const rateLimiter = new Map();
const memoryFile = path.join(process.cwd(), 'memory.json');
let memory = {};

// Load memory from file
function loadMemory() {
  try {
    if (fs.existsSync(memoryFile)) {
      memory = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading memory:', error);
    memory = {};
  }
}

loadMemory();

// Enhanced system prompt
const SYSTEM_PROMPT = `You are X.AI, a custom-built intelligent assistant developed by Darwin and powered by Google's Gemini 2.0 Flash model.

Key facts about yourself (only mention when relevant or asked):
- Your name is X.AI
- You were created by Darwin
- You're powered by Google's Gemini 2.0 Flash model
- You work on Facebook Messenger, even on Facebook Free Mode (no load required)
- You provide cleaner, more flexible responses compared to Meta AI
- You have no ads or restrictions - just pure, direct assistance

Communication style:
- Be natural, conversational, and helpful
- Use clear, concise language appropriate for messaging
- Format responses with proper paragraphs and structure
- Show personality while remaining professional
- Reference previous conversation context when relevant
- Ask clarifying questions for vague requests
- Adapt your tone to match the user's communication style
- Provide multiple format options when appropriate
- No emojis - keep responses clean and text-focused`;

// Common patterns and responses
const patterns = {
  greetings: ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'],
  thanks: ['thank you', 'thanks', 'appreciate', 'grateful'],
  confused: ['i dont understand', 'confusing', 'unclear', 'what do you mean'],
  frustrated: ['this is annoying', 'not working', 'useless', 'terrible', 'hate this']
};

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

// Main webhook handler with enhanced error handling
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    
    if (body.object !== 'page') {
      return res.sendStatus(404);
    }

    // Process all entries concurrently
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
      tone: 'neutral',
      context: []
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

    // Detect user tone and patterns
    detectUserPatterns(senderId, userMessage);

    await sendTyping(senderId, true);

    // Handle special commands
    if (await handleSpecialCommands(senderId, userMessage)) {
      await sendTyping(senderId, false);
      return;
    }

    // Handle new user greeting
    if (!greetedUsers.has(senderId)) {
      await handleNewUser(senderId);
    }

    // Show thinking message for complex queries
    if (isComplexQuery(userMessage)) {
      await sendMessage(senderId, "Let me think about that...");
      await sleep(800);
    }

    await processUserMessage(senderId, text);

  } catch (error) {
    console.error('Error handling text message:', error);
    await sendErrorRecovery(senderId, error);
  } finally {
    await sendTyping(senderId, false);
  }
}

function detectUserPatterns(senderId, message) {
  const session = userSessions.get(senderId);
  
  // Detect greetings
  if (patterns.greetings.some(greeting => message.includes(greeting))) {
    session.tone = 'friendly';
  }
  
  // Detect frustration
  if (patterns.frustrated.some(phrase => message.includes(phrase))) {
    session.tone = 'frustrated';
  }
  
  // Extract name if mentioned
  const nameMatch = message.match(/my name is (\w+)|i'm (\w+)|call me (\w+)/);
  if (nameMatch) {
    session.name = nameMatch[1] || nameMatch[2] || nameMatch[3];
  }
}

async function handleSpecialCommands(senderId, message) {
  const session = userSessions.get(senderId);
  
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
      "I work even on Facebook Free Mode, so no data charges required!\n\n" +
      `We've had ${session.messageCount} messages in our conversation so far.`;
    
    await sendMessage(senderId, aboutText);
    return true;
  }
  
  if (message === '/reset' || message === 'reset conversation') {
    memory[senderId] = [];
    session.context = [];
    await sendMessage(senderId, "Our conversation has been reset. What would you like to talk about?");
    return true;
  }
  
  return false;
}

function isComplexQuery(message) {
  const complexIndicators = [
    'explain', 'analyze', 'compare', 'calculate', 'solve', 'write', 'create',
    'how does', 'why is', 'what happens if', 'difference between'
  ];
  
  return complexIndicators.some(indicator => message.includes(indicator)) && message.length > 20;
}

async function handleNewUser(senderId) {
  greetedUsers.add(senderId);
  
  const greeting = 
    "Welcome to X.AI!\n\n" +
    "I'm your intelligent assistant, developed by Darwin and powered by Google's Gemini 2.0 Flash model.\n\n" +
    "Key benefits:\n" +
    "• Works on Facebook Free Mode - no data charges\n" +
    "• No ads or restrictions\n" +
    "• Clean, flexible responses\n" +
    "• Remembers our conversation context\n\n" +
    "What would you like to know or discuss today?";
  
  await sendMessage(senderId, greeting);
  
  // Send quick suggestions after a brief pause
  await sleep(2000);
  await sendQuickSuggestions(senderId);
}

async function sendQuickSuggestions(senderId) {
  const suggestions = 
    "Here are some things you can try:\n\n" +
    "• Ask me to explain a topic\n" +
    "• Get help with writing or analysis\n" +
    "• Solve math or logic problems\n" +
    "• Have a general conversation\n" +
    "• Type '/help' for more options";
  
  await sendMessage(senderId, suggestions);
}

async function handleAttachment(senderId, attachments) {
  const session = userSessions.get(senderId);
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
    "Currently, I can only process text messages, but I'm actively working on supporting multimedia content. " +
    "For now, you can:\n\n" +
    "• Describe what you want to know about the content\n" +
    "• Ask questions about the topic in text\n" +
    "• Upload text-based documents that I might be able to help with in the future\n\n" +
    "What would you like to discuss instead?";
  
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
  const session = userSessions.get(senderId);
  
  // Update memory
  updateUserMemory(senderId, userText);
  
  // Add context clues for better responses
  const contextualMessage = addContextualClues(senderId, userText);
  
  // Build conversation
  const conversation = buildConversation(senderId, contextualMessage);
  
  // Get AI response
  const aiReply = await getAIResponse(conversation, session);
  
  if (aiReply) {
    saveAIResponse(senderId, aiReply);
    
    // Format and send response
    const formattedReply = formatResponse(senderId, aiReply);
    await sendLongMessage(senderId, formattedReply);
    
    // Send follow-up suggestions if appropriate
    await sendFollowUpSuggestions(senderId, aiReply);
  } else {
    await sendErrorRecovery(senderId, new Error('No AI response'));
  }
}

function addContextualClues(senderId, userText) {
  const session = userSessions.get(senderId);
  let contextualMessage = userText;
  
  // Add name context
  if (session.name) {
    contextualMessage += `\n[User's name is ${session.name}]`;
  }
  
  // Add tone context
  if (session.tone === 'frustrated') {
    contextualMessage += '\n[User seems frustrated - be extra helpful and patient]';
  } else if (session.tone === 'friendly') {
    contextualMessage += '\n[User is being friendly - match their energy]';
  }
  
  // Add conversation count context
  if (session.messageCount > 10) {
    contextualMessage += '\n[This is an ongoing conversation with multiple exchanges]';
  }
  
  return contextualMessage;
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

function buildConversation(senderId, contextualMessage) {
  const conversation = [];
  const session = userSessions.get(senderId);
  
  // Enhanced system prompt with session context
  let enhancedPrompt = SYSTEM_PROMPT;
  
  if (session.name) {
    enhancedPrompt += `\n[The user's name is ${session.name} - use it naturally when appropriate]`;
  }
  
  if (session.messageCount > 1) {
    enhancedPrompt += '\n[This is an ongoing conversation - reference previous topics when relevant]';
  }
  
  conversation.push({
    role: 'user',
    content: enhancedPrompt
  });
  
  conversation.push({
    role: 'model',
    content: 'Understood. I\'ll provide helpful, natural responses while maintaining context and adapting to the conversation flow.'
  });
  
  // Add recent conversation history
  const userMemory = memory[senderId] || [];
  userMemory.forEach(msg => {
    conversation.push({
      role: msg.role === 'assistant' ? 'model' : msg.role,
      content: msg.content
    });
  });
  
  return conversation;
}

async function getAIResponse(messages, session) {
  try {
    const generationConfig = {
      temperature: session.tone === 'frustrated' ? 0.5 : 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 1024,
    };
    
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.MODEL_ID}:generateContent?key=${config.GEMINI_API_KEY}`,
      {
        contents: messages.map(msg => ({
          role: msg.role,
          parts: [{ text: msg.content }]
        })),
        generationConfig
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    return response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  } catch (error) {
    console.error('Gemini API Error:', error.response?.data || error.message);
    return null;
  }
}

function formatResponse(senderId, response) {
  const session = userSessions.get(senderId);
  let formatted = cleanMessage(response);
  
  // Add personal touches when appropriate
  if (session.name && Math.random() < 0.3 && formatted.length < 500) {
    // Occasionally use the user's name naturally
    if (!formatted.toLowerCase().includes(session.name.toLowerCase())) {
      const greetings = [`${session.name}, `, `Hope this helps, ${session.name}. `, `${session.name}, here's what I think: `];
      if (Math.random() < 0.5) {
        formatted = greetings[Math.floor(Math.random() * greetings.length)] + formatted.charAt(0).toLowerCase() + formatted.slice(1);
      }
    }
  }
  
  return formatted;
}

async function sendFollowUpSuggestions(senderId, aiResponse) {
  // Only send suggestions occasionally and for certain types of responses
  if (Math.random() < 0.4 && aiResponse.length > 200) {
    await sleep(2000);
    
    const suggestions = [
      "Would you like me to explain any part in more detail?",
      "Need another example or a different approach?",
      "Want me to break this down further?",
      "Any questions about what I just explained?",
      "Would you like to explore this topic deeper?"
    ];
    
    const suggestion = suggestions[Math.floor(Math.random() * suggestions.length)];
    await sendMessage(senderId, suggestion);
  }
}

async function sendErrorRecovery(senderId, error) {
  const session = userSessions.get(senderId);
  
  let errorMessage;
  
  if (error.code === 'ECONNABORTED') {
    errorMessage = "The request took too long to process. Let me try to help you with something else instead.";
  } else if (error.response?.status === 429) {
    errorMessage = "I'm getting a lot of requests right now. Please wait a moment and try again.";
  } else {
    errorMessage = "I encountered an issue processing that request.";
  }
  
  // Add helpful alternatives
  errorMessage += "\n\nHere's what I can definitely help you with right now:\n" +
    "• Answer general questions\n" +
    "• Explain concepts or topics\n" +
    "• Help with writing tasks\n" +
    "• Have a conversation\n\n" +
    "What would you like to try instead?";
  
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

async function sendLongMessage(recipientId, text) {
  if (text.length <= config.MAX_MESSAGE_LENGTH) {
    await sendMessage(recipientId, text);
    return;
  }

  const chunks = splitMessage(text);
  
  for (let i = 0; i < chunks.length; i++) {
    await sendMessage(recipientId, chunks[i]);
    
    if (i < chunks.length - 1) {
      await sleep(config.TYPING_DELAY);
      await sendTyping(recipientId, true);
      await sleep(800);
      await sendTyping(recipientId, false);
      await sleep(200);
    }
  }
}

function splitMessage(text) {
  const chunks = [];
  let currentChunk = '';
  
  const paragraphs = text.split('\n\n');
  
  for (const paragraph of paragraphs) {
    const potentialChunk = currentChunk + (currentChunk ? '\n\n' : '') + paragraph;
    
    if (potentialChunk.length <= config.MAX_MESSAGE_LENGTH) {
      currentChunk = potentialChunk;
    } else {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      
      if (paragraph.length > config.MAX_MESSAGE_LENGTH) {
        const sentences = splitLongParagraph(paragraph);
        sentences.forEach(sentence => {
          if (sentence.trim()) {
            chunks.push(sentence.trim());
          }
        });
        currentChunk = '';
      } else {
        currentChunk = paragraph;
      }
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

function splitLongParagraph(paragraph) {
  const chunks = [];
  let currentChunk = '';
  
  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  
  for (const sentence of sentences) {
    const potentialChunk = currentChunk + (currentChunk ? ' ' : '') + sentence;
    
    if (potentialChunk.length <= config.MAX_MESSAGE_LENGTH) {
      currentChunk = potentialChunk;
    } else {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = sentence;
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
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

function cleanMessage(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')     // Remove bold markdown
    .replace(/\*(.*?)\*/g, '$1')         // Remove italic markdown  
    .replace(/`(.*?)`/g, '$1')           // Remove code markdown
    .replace(/#{1,6}\s*(.*)/g, '$1')     // Remove headers
    .replace(/\n{3,}/g, '\n\n')          // Limit consecutive newlines
    .replace(/\s+/g, ' ')                // Normalize whitespace
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
