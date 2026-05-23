import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import admin from 'firebase-admin';

dotenv.config();

// Initialize Firebase Admin
admin.initializeApp({
  projectId: process.env.FIREBASE_PROJECT_ID || "ideavault-93bdf",
});

const app = express();
const PORT = 3000;

app.use(cors({
  origin: function (origin, callback) {
    callback(null, true);
  },
  credentials: true
}));

app.use(express.json());


const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("CRITICAL WARNING: MONGODB_URI environment variable is not set!");
  console.error("Please add your MongoDB connection string in the Secrets panel to use the database.");
}

mongoose.connect(MONGODB_URI || 'mongodb://127.0.0.1:27017/ideavault', {
  serverSelectionTimeoutMS: 5000,
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('Failed to connect to MongoDB. Check your MONGODB_URI secret:', err.message);
});


app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/jwt' || req.path.startsWith('/auth')) return next();
  
  if (mongoose.connection.readyState !== 1 && mongoose.connection.readyState !== 2) {
    return res.status(503).json({ 
      error: 'Database not connected. Please provide a valid MONGODB_URI in the Secrets panel.' 
    });
  }
  next();
});


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


const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Unauthorized access' });
    }
    
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    req.user = {
      email: decodedToken.email,
      name: decodedToken.name || 'Anonymous',
      photo: decodedToken.picture || ''
    };
    next();
  } catch (error) {
    console.error("Session error:", error);
    res.status(401).json({ message: 'Unauthorized access' });
  }
};




app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'IdeaVault API is running.' });
});

app.get('/api/config', (req, res) => {
  res.json({
    hasExternalDb: !!process.env.MONGODB_URI,
    message: process.env.MONGODB_URI ? 'Connected to External DB.' : 'Warning: Using ephemeral local memory database. Data will be lost on container restart.'
  });
});


app.post('/api/jwt', (req, res) => {
  const user = req.body;
  if (!user || !user.email) return res.status(400).json({ error: 'Missing user data' });
  const token = jwt.sign(user, process.env.JWT_SECRET || 'fallback_secret_key', { expiresIn: '1d' });
  res.json({ token });
});


app.get('/api/ideas', async (req, res) => {
  const { search, category, limit } = req.query;
  const filter = {};
  if (search) {
    filter.title = { $regex: search, $options: 'i' };
  }
  if (category && category !== 'All' && category !== '') {
    filter.category = category;
  }
  
  let query = Idea.find(filter).sort({ createdAt: -1 });
  if (limit) {
    query = query.limit(Number(limit));
  }
  
  try {
    const ideas = await query;
    res.json(ideas);
  } catch (error) {
    console.error('Error fetching ideas:', error);
    res.status(500).json({ error: 'Failed to fetch ideas' });
  }
});

app.get('/api/ideas/trending', async (req, res) => {
  try {
    const ideas = await Idea.find().sort({ interactionCount: -1, createdAt: -1 }).limit(6);
    res.json(ideas);
  } catch (error) {
    console.error('Error fetching trending:', error);
    res.status(500).json({ error: 'Failed to fetch trending ideas' });
  }
});

app.get('/api/ideas/:id', async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Idea not found' });
    res.json(idea);
  } catch (error) {
    console.error('Error fetching idea by id:', error);
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
    console.log("Saving new idea:", newIdea.title, "by", newIdea.creatorEmail);
    await newIdea.save();
    console.log("Successfully saved new idea. ID:", newIdea._id);
    res.status(201).json(newIdea);
  } catch (error) {
    console.error('Error adding idea:', error);
    res.status(500).json({ error: 'Failed to add idea', details: error.message });
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
      userName: req.body.userName,
      userPhoto: req.body.userPhoto,
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
    console.error('Error user ideas:', error);
    res.status(500).json({ error: 'Server error' });
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
    console.error('Error user interactions:', error);
    res.status(500).json({ error: 'Server error' });
  }
});



async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';
  const fs = await import('fs');
  
  // Custom API fallback for root when dist doesn't exist
  app.get('/', (req, res, next) => {
    if (isProduction && !fs.existsSync(path.join(process.cwd(), 'dist', 'index.html'))) {
      res.send(`
        <html>
          <head>
            <title>IdeaVault API Status</title>
            <style>
              body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f9fafb; margin: 0; color: #111827; }
              .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); }
              h1 { margin-top: 0; }
              a { color: #2563eb; text-decoration: none; }
              a:hover { text-decoration: underline; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>IdeaVault Backend API</h1>
              <p>The backend service is running successfully.</p>
              <p><a href="/api/health">Check API Health</a></p>
            </div>
          </body>
        </html>
      `);
    } else {
      next();
    }
  });

  if (!isProduction) {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      console.log('Vite middleware enabled');
    } catch (e) {
      console.warn('Vite not found, falling back to static dist folder.', e.message);
      app.use(express.static(path.join(process.cwd(), 'dist')));
      app.get('*', (req, res) => {
        const indexPath = path.join(process.cwd(), 'dist', 'index.html');
        if (fs.existsSync(indexPath)) {
          res.sendFile(indexPath);
        } else {
          res.status(404).json({ error: 'Not Found', message: 'API endpoint does not exist or frontend is not built.' });
        }
      });
    }
  } else {
    app.use(express.static(path.join(process.cwd(), 'dist')));
    app.get('*', (req, res) => {
      const indexPath = path.join(process.cwd(), 'dist', 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).json({ error: 'Not Found', message: 'API endpoint does not exist or frontend is not built.' });
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
