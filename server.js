import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";

dotenv.config();

const app = express();
app.enable('trust proxy');
const PORT = process.env.PORT || 3000;

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

app.use(cors({
  origin: FRONTEND_URL, 
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie']
}));
app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ideavault';

mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
}).then(() => {
  console.log('Connected to MongoDB via Mongoose cleanly');
}).catch(err => {
  console.error('Failed to establish connection to MongoDB database:', err.message);
});

export const auth = betterAuth({
  database: {
    provider: "mongodb",
    url: MONGODB_URI
  },
  emailAndPassword: {
    enabled: true
  },
  trustedOrigins: [
    FRONTEND_URL,
    'http://localhost:5173'
  ],
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production"
  }
});

app.all("/api/auth/*", (req, res) => {
  auth.handler(req);
});

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path === '/health' || req.path === '/config') {
    return next();
  }
  
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ 
      error: 'Database connection is still spawning. Please refresh in a brief moment.' 
    });
  }
  next();
});

const verifyToken = async (req, res, next) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    
    if (!session) {
      return res.status(401).json({ message: 'Unauthorized access' });
    }
    
    req.user = {
      email: session.user.email,
      name: session.user.name,
      photo: session.user.image
    };
    next();
  } catch (error) {
    console.error("Auth middleware tracking token error:", error);
    res.status(500).json({ error: "Internal authentication configuration conflict" });
  }
};

const CommentSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  userName: { type: String, required: true },
  userPhoto: { type: String },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const IdeaSchema = new mongoose.Schema({
  title: { type: String, required: true },
  shortDescription: { type: String, required: true },
  detailedDescription: { type: String, required: true },
  category: { type: String, required: true },
  tags: [String],
  imageUrl: { type: String },
  estimatedBudget: { type: String },
  targetAudience: { type: String, required: true },
  problemStatement: { type: String, required: true },
  proposedSolution: { type: String, required: true },
  creatorEmail: { type: String, required: true },
  creatorName: { type: String, required: true },
  creatorPhoto: { type: String },
  comments: [CommentSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  interactionCount: { type: Number, default: 0 }
});

const Idea = mongoose.model('Idea', IdeaSchema);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'IdeaVault API is running cleanly.' });
});

app.get('/api/config', (req, res) => {
  res.json({
    hasExternalDb: !!process.env.MONGODB_URI,
    message: process.env.MONGODB_URI ? 'Connected to External Database.' : 'Warning: Using default engine.'
  });
});

app.get('/api/ideas', async (req, res) => {
  const { search, category, limit } = req.query;
  const filter = {};
  if (search) filter.title = { $regex: search, $options: 'i' };
  if (category && category !== 'All' && category !== '') filter.category = category;
  
  let query = Idea.find(filter).sort({ createdAt: -1 });
  if (limit) query = query.limit(Number(limit));
  
  try {
    const ideas = await query;
    res.json(ideas);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ideas matching array constraints' });
  }
});

app.get('/api/ideas/trending', async (req, res) => {
  try {
    const ideas = await Idea.find().sort({ interactionCount: -1, createdAt: -1 }).limit(6);
    res.json(ideas);
  } catch (error) {
    res.status(500).json({ error: 'Failed to safely render dataset' });
  }
});

app.get('/api/ideas/:id', async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    res.json(idea);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/ideas', verifyToken, async (req, res) => {
  try {
    const newIdea = new Idea({
      ...req.body, 
      creatorEmail: req.user.email,
      creatorName: req.user.name || 'Anonymous',
      creatorPhoto: req.user.photo || ''
    });
    await newIdea.save();
    res.status(201).json(newIdea);
  } catch (error) {
    res.status(500).json({ error: 'Failed to record custom item profile' });
  }
});

app.put('/api/ideas/:id', verifyToken, async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Not found' });
    if (idea.creatorEmail !== req.user.email) return res.status(403).json({ error: 'Forbidden' });
    
    Object.assign(idea, req.body);
    idea.updatedAt = new Date();
    await idea.save();
    res.json(idea);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

app.delete('/api/ideas/:id', verifyToken, async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Not found' });
    if (idea.creatorEmail !== req.user.email) return res.status(403).json({ error: 'Forbidden' });
    await Idea.deleteOne({ _id: req.params.id });
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

app.post('/api/ideas/:id/comments', verifyToken, async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    
    const comment = {
      userId: req.user.email,
      userName: req.user.name || 'Anonymous',
      userPhoto: req.user.photo || '',
      text: req.body.text,
      createdAt: new Date()
    };
    idea.comments.push(comment);
    idea.interactionCount = (idea.interactionCount || 0) + 1;
    await idea.save();
    res.json(idea.comments[idea.comments.length - 1]);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/ideas/:postId/comments/:commentId', verifyToken, async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.postId);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    
    const comment = idea.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.userId !== req.user.email) return res.status(403).json({ error: 'Forbidden' });
    
    comment.text = req.body.text;
    await idea.save();
    res.json(comment);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/ideas/:postId/comments/:commentId', verifyToken, async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.postId);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    
    const comment = idea.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.userId !== req.user.email) return res.status(403).json({ error: 'Forbidden' });
    
    idea.comments.pull(req.params.commentId);
    idea.interactionCount = Math.max((idea.interactionCount || 0) - 1, 0);
    await idea.save();
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users/:email/ideas', verifyToken, async (req, res) => {
  if (req.params.email !== req.user.email) return res.status(403).json({ error: 'Forbidden' });
  try {
    const ideas = await Idea.find({ creatorEmail: req.params.email }).sort({ createdAt: -1 });
    res.json(ideas);
  } catch (error) {
    res.status(500).json({ error: 'Server error parsing index' });
  }
});

app.get('/api/users/:email/interactions', verifyToken, async (req, res) => {
  if (req.params.email !== req.user.email) return res.status(403).json({ error: 'Forbidden' });
  try {
    const ideas = await Idea.find({ 'comments.userId': req.params.email })
      .select('title shortDescription creatorName comments category imageUrl createdAt')
      .sort({ createdAt: -1 });
    res.json(ideas);
  } catch (error) {
    res.status(500).json({ error: 'Server error parsing map collection' });
  }
});

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';
  const fs = await import('fs');
  
  if (isProduction) {
    app.use(express.static(path.join(process.cwd(), 'dist')));
    app.get('*', (req, res) => {
      const indexPath = path.join(process.cwd(), 'dist', 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).json({ error: 'Not Found', message: 'API active.' });
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running securely on port ${PORT}`);
  });
}

startServer();