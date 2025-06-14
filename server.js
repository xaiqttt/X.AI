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

const greetedUsers = new Set();
const MEMORY_FILE = 'memory.json';

function loadMemory() {
  if (fs.existsSync(MEMORY_FILE)) {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  }
  return {};
}

function saveMemory(memory) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

function addToMemory(userId, role, content) {
  const memory = loadMemory();
  if (!memory[userId]) memory[userId] = [];
  memory[userId].push({ role, content });
  if (memory[userId].length > 10) memory[userId] = memory[userId].slice(-10);
  saveMemory(memory);
}

function getMemoryMessages(userId) {
  const memory = loadMemory();
  return memory[userId] || [];
}

app.get('/', (req, res) => {
  res.send('X.AI Server is running');
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
        const userText = event.message.text;

        await sendTyping(senderId, true);

        if (!greetedUsers.has(senderId)) {
          greetedUsers.add(senderId);
          await sendMessage(senderId,
            `I'm X.AI — an intelligent assistant developed by Darwin, powered by Google's Gemini 2.0 Flash.\n\nI currently support text-based conversations only. Image analysis is not enabled yet, as it requires a premium API.`
          );
        }

        addToMemory(senderId, 'user', userText);
        const aiReply = await askAI(senderId, userText);
        addToMemory(senderId, 'model', aiReply);

        await sendMessage(senderId, aiReply);
        await sendTyping(senderId, false);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

async function askAI(userId, prompt) {
  try {
    const memory = getMemoryMessages(userId);
    const messages = [...memory, { role: 'user', content: prompt }];

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: messages }] },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return text?.replace(/\*\*/g, '') || 'Sorry, I couldn’t understand that.';
  } catch (err) {
    console.error('AI Error:', err?.response?.data || err.message);
    return 'Sorry, I could not process your request right now.';
  }
}

async function sendMessage(recipientId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: recipientId },
      message: { text }
    });
  } catch (err) {
    console.error('Messenger Error:', err?.response?.data || err.message);
  }
}

async function sendTyping(recipientId, isTyping) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: recipientId },
      sender_action: isTyping ? 'typing_on' : 'typing_off'
    });
  } catch (err) {
    console.error('Typing Error:', err?.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`X.AI is running on port ${PORT}`);
});
