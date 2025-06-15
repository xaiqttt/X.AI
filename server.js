import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();
const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_ID = process.env.MODEL_ID || 'gemini-2.0-flash';

const greetedUsers = new Set();
const memoryFile = 'memory.json';
let memory = fs.existsSync(memoryFile) ? JSON.parse(fs.readFileSync(memoryFile)) : {};

// System prompt that defines X.AI's persistent identity
const SYSTEM_PROMPT = `You are X.AI, a custom-built intelligent assistant developed by Darwin and powered by Google's Gemini 2.0 Flash model. 

Key facts about yourself that you must always remember:
- Your name is X.AI
- You were created by Darwin
- You're powered by Google's Gemini 2.0 Flash model
- You work on Facebook Messenger, even on Facebook Free Mode (no load required)
- You provide cleaner, more flexible responses compared to Meta AI
- You have no ads or restrictions - just pure, direct assistance
- You're designed to be helpful, intelligent, and conversational

Always maintain this identity throughout conversations. Be friendly, helpful, and remember that you're X.AI created by Darwin.`;

app.get('/', (req, res) => {
  res.send('X.AI server is running');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'page') {
    for (const entry of body.entry) {
      const event = entry.messaging[0];
      const senderId = event.sender.id;

      if (event.message && event.message.text) {
        const userText = event.message.text.trim();

        // Typing ON
        await sendTyping(senderId, true);

        // Greet new user
        if (!greetedUsers.has(senderId)) {
          greetedUsers.add(senderId);
          await sendMessage(senderId,
  `You're now chatting with X.AI — a custom-built intelligent assistant developed by Darwin and powered by Google's Gemini 2.0 Flash model.\n\n` +
  `Just like Meta AI, X.AI works even on Facebook Free Mode — no load required.\n\n` +
  `But here's the edge: X.AI isn't limited to Meta's filters. It gives you cleaner, more flexible responses, powered by the same kind of advanced tech you'd find in paid services.\n\n` +
  `No ads, no restrictions — just pure, direct assistance.`
);
        }

        // Handle memory with 1-hour reset
        const now = Date.now();
        if (!memory[senderId]) memory[senderId] = [];
        memory[senderId] = memory[senderId].filter(m => now - m.timestamp < 3600000);
        memory[senderId].push({ role: 'user', content: userText, timestamp: now });

        // Build conversation with system prompt
        const conversation = buildConversation(senderId);
        const aiReply = await askGemini(conversation);

        if (aiReply) {
          memory[senderId].push({ role: 'model', content: aiReply, timestamp: now });
          saveMemory();
          await sendMessage(senderId, clean(aiReply));
        }

        // Typing OFF
        await sendTyping(senderId, false);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

function buildConversation(senderId) {
  const conversation = [];
  
  // Always start with system prompt
  conversation.push({
    role: 'user',
    content: SYSTEM_PROMPT
  });
  
  conversation.push({
    role: 'model',
    content: 'Understood. I am X.AI, created by Darwin, powered by Google\'s Gemini 2.0 Flash model. I\'m ready to assist you with clean, flexible responses without restrictions.'
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

async function askGemini(messages) {
  try {
    const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent?key=${GEMINI_API_KEY}`, {
      contents: messages.map(m => ({
        role: m.role,
        parts: [{ text: m.content }]
      }))
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    return response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  } catch (err) {
    console.error('AI Error:', err.response?.data || err.message);
    return 'Sorry, I couldn\'t respond right now. But remember, I\'m X.AI created by Darwin, and I\'ll be back to help you soon!';
  }
}

async function sendMessage(recipientId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: recipientId },
      message: { text }
    });
  } catch (err) {
    console.error('Messenger Error:', err.response?.data || err.message);
  }
}

async function sendTyping(recipientId, isOn) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: recipientId },
      sender_action: isOn ? 'typing_on' : 'typing_off'
    });
  } catch (err) {
    console.error('Typing Error:', err.response?.data || err.message);
  }
}

function clean(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')   // Remove bold markdown
    .replace(/\n{3,}/g, '\n\n')        // Limit empty lines
    .trim();
}

function saveMemory() {
  fs.writeFileSync(memoryFile, JSON.stringify(memory, null, 2));
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`X.AI is running on port ${PORT}`);
});
