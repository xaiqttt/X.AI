import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const greetedUsers = new Set();
const userConversations = new Map();

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
        const userText = event.message.text.trim();
        console.log(`[${senderId}] ${userText}`);

        await sendTyping(senderId);

        // Show welcome message once
        if (!greetedUsers.has(senderId)) {
          greetedUsers.add(senderId);
          await sendMessage(senderId,
            `Hi, I'm X.AI. Created by Darwin. I'm powered by Gemini Pro (text-only). I don’t support image analysis yet because it needs a paid tier or extra setup. Let's talk!`
          );
        }

        // Handle commands
        if (userText.startsWith('/')) {
          const cmd = userText.toLowerCase();
          if (cmd === '/help') {
            return await sendMessage(senderId, `Commands:\n/help → Show this help\n/about → About me\n/clear → Clear chat memory`);
          }
          if (cmd === '/about') {
            return await sendMessage(senderId, `I'm X.AI, powered by Google's Gemini-Pro via free API. Built for text conversations.`);
          }
          if (cmd === '/clear') {
            userConversations.delete(senderId);
            return await sendMessage(senderId, `Chat memory cleared.`);
          }
        }

        const aiReply = await askGemini(senderId, userText);
        await sendMessage(senderId, aiReply);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

async function askGemini(senderId, prompt) {
  try {
    const history = userConversations.get(senderId) || [];
    history.push({ role: 'user', parts: [{ text: prompt }] });

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
      { contents: history },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const reply = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "I couldn't understand that.";
    history.push({ role: 'model', parts: [{ text: reply }] });

    // Save updated history
    userConversations.set(senderId, history.slice(-10)); // limit memory
    return reply.trim();
  } catch (err) {
    console.error('Gemini Error:', err?.response?.data || err.message);
    return `Sorry, I’m having trouble connecting to my brain right now. Try again later.`;
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

async function sendTyping(recipientId) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: recipientId },
      sender_action: 'typing_on'
    });
  } catch (err) {
    console.error('Typing Error:', err?.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`X.AI is running on port ${PORT}`);
});
