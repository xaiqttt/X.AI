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
const memoryFile = 'memory.json';
let conversations = {};

// Load memory
if (fs.existsSync(memoryFile)) {
  conversations = JSON.parse(fs.readFileSync(memoryFile));
}

// Reset memory every hour
setInterval(() => {
  conversations = {};
  fs.writeFileSync(memoryFile, JSON.stringify(conversations));
}, 60 * 60 * 1000); // 1 hour

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
        const userText = event.message.text.toLowerCase();

        // Greet first-time user
        if (!greetedUsers.has(senderId)) {
          greetedUsers.add(senderId);
          await sendMessage(senderId,
            `You're now chatting with X.AI — a custom-built intelligent assistant developed by Darwin and powered by Google's Gemini 2.0 Flash model.\n\n` +
            `Just like Meta AI, X.AI works even on Facebook Free Mode — no load required.\n\n` +
            `But here's the edge: X.AI isn't limited to Meta's filters. It gives you cleaner, more flexible responses, powered by the same kind of advanced tech you'd find in paid services.\n\n` +
            `No ads, no restrictions — just pure, direct assistance.`
          );
        }

        // Identity response
        const identityTriggers = ['who is him', 'who are you', 'what is x.ai', 'who made you'];
        if (identityTriggers.some(q => userText.includes(q))) {
          await sendMessage(senderId, `I'm X.AI, an intelligent assistant created by Darwin.`);
          return;
        }

        // Add to conversation memory
        if (!conversations[senderId]) conversations[senderId] = [];
        conversations[senderId].push({ role: 'user', parts: [{ text: userText }] });

        const aiReply = await askAI(conversations[senderId]);
        conversations[senderId].push({ role: 'model', parts: [{ text: aiReply }] });
        fs.writeFileSync(memoryFile, JSON.stringify(conversations));

        await sendMessage(senderId, aiReply);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

async function askAI(history) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: history },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text?.trim() || 'I couldn’t come up with a reply.';
  } catch (err) {
    console.error('AI Error:', err.response?.data || err.message);
    return 'Sorry, I couldn’t process that right now.';
  }
}

async function sendMessage(recipientId, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: { text }
      }
    );
    // Turn off typing indicator
    await axios.post(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        sender_action: 'typing_off'
      }
    );
  } catch (err) {
    console.error('Messenger Error:', err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`X.AI is running on port ${PORT}`);
});
