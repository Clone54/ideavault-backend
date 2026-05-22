import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';

const app = express();

app.enable('trust proxy');

const PORT = process.env.PORT || 3000;

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  'http://localhost:5173';

const MONGODB_URI =
  process.env.MONGODB_URI ||
  'mongodb://127.0.0.1:27017/ideavault';

const isProduction =
  process.env.NODE_ENV === 'production';

app.use(
  cors({
    origin: [
      FRONTEND_URL,
      'http://localhost:5173',
      'https://ideavault-frontend-1.onrender.com'
    ],
    credentials: true
  })
);

app.options('*', cors());

app.use(express.json());

export let auth = null;

app.all('/api/auth/*', async (req, res) => {
  try {
    if (!auth) {
      return res.status(503).json({
        error: 'Authentication service initializing'
      });
    }

    return await auth.handler(req, res);
  } catch (error) {
    console.error('Better Auth Error:', error);

    return res.status(500).json({
      error: 'Authentication handler crashed'
    });
  }
});

app.use('/api', (req, res, next) => {
  if (
    req.path.startsWith('/auth') ||
    req.path === '/health' ||
    req.path === '/config'
  ) {
    return next();
  }

  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error:
        'Database initialization pending. Please try again.'
    });
  }

  next();
});

const verifyToken = async (req, res, next) => {
  try {
    if (!auth) {
      return res.status(503).json({
        error: 'Auth engine offline'
      });
    }

    const session = await auth.api.getSession({
      headers: req.headers
    });

    if (!session) {
      return res.status(401).json({
        error: 'Unauthorized access'
      });
    }

    req.user = {
      email: session.user.email,
      name: session.user.name,
      photo: session.user.image
    };

    next();
  } catch (error) {
    console.error('Verify token error:', error);

    return res.status(500).json({
      error: 'Internal authentication error'
    });
  }
};

const CommentSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true
  },
  userName: {
    type: String,
    required: true
  },
  userPhoto: {
    type: String
  },
  text: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const IdeaSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  shortDescription: {
    type: String,
    required: true
  },
  detailedDescription: {
    type: String,
    required: true
  },
  category: {
    type: String,
    required: true
  },
  tags: [String],
  imageUrl: {
    type: String
  },
  estimatedBudget: {
    type: String
  },
  targetAudience: {
    type: String,
    required: true
  },
  problemStatement: {
    type: String,
    required: true
  },
  proposedSolution: {
    type: String,
    required: true
  },
  creatorEmail: {
    type: String,
    required: true
  },
  creatorName: {
    type: String,
    required: true
  },
  creatorPhoto: {
    type: String
  },
  comments: [CommentSchema],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  interactionCount: {
    type: Number,
    default: 0
  }
});

const Idea = mongoose.model('Idea', IdeaSchema);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'IdeaVault API running'
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    hasExternalDb: !!process.env.MONGODB_URI,
    message: process.env.MONGODB_URI
      ? 'Connected to external database'
      : 'Using local database'
  });
});

app.get('/api/ideas', async (req, res) => {
  try {
    const { search, category, limit } = req.query;

    const filter = {};

    if (search) {
      filter.title = {
        $regex: search,
        $options: 'i'
      };
    }

    if (
      category &&
      category !== 'All' &&
      category !== ''
    ) {
      filter.category = category;
    }

    let query = Idea.find(filter).sort({
      createdAt: -1
    });

    if (limit) {
      query = query.limit(Number(limit));
    }

    const ideas = await query;

    return res.json(ideas);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Failed to fetch ideas'
    });
  }
});

app.get('/api/ideas/trending', async (req, res) => {
  try {
    const ideas = await Idea.find()
      .sort({
        interactionCount: -1,
        createdAt: -1
      })
      .limit(6);

    return res.json(ideas);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Failed to fetch trending ideas'
    });
  }
});

app.get('/api/ideas/:id', async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.id);

    if (!idea) {
      return res.status(404).json({
        error: 'Idea not found'
      });
    }

    return res.json(idea);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Server error'
    });
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

    return res.status(201).json(newIdea);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Failed to create idea'
    });
  }
});

app.put('/api/ideas/:id', verifyToken, async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.id);

    if (!idea) {
      return res.status(404).json({
        error: 'Idea not found'
      });
    }

    if (idea.creatorEmail !== req.user.email) {
      return res.status(403).json({
        error: 'Forbidden'
      });
    }

    Object.assign(idea, req.body);

    idea.updatedAt = new Date();

    await idea.save();

    return res.json(idea);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Failed to update idea'
    });
  }
});

app.delete('/api/ideas/:id', verifyToken, async (req, res) => {
  try {
    const idea = await Idea.findById(req.params.id);

    if (!idea) {
      return res.status(404).json({
        error: 'Idea not found'
      });
    }

    if (idea.creatorEmail !== req.user.email) {
      return res.status(403).json({
        error: 'Forbidden'
      });
    }

    await Idea.deleteOne({
      _id: req.params.id
    });

    return res.json({
      message: 'Idea deleted'
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Failed to delete idea'
    });
  }
});

app.post(
  '/api/ideas/:id/comments',
  verifyToken,
  async (req, res) => {
    try {
      const idea = await Idea.findById(req.params.id);

      if (!idea) {
        return res.status(404).json({
          error: 'Idea not found'
        });
      }

      const comment = {
        userId: req.user.email,
        userName: req.user.name || 'Anonymous',
        userPhoto: req.user.photo || '',
        text: req.body.text,
        createdAt: new Date()
      };

      idea.comments.push(comment);

      idea.interactionCount =
        (idea.interactionCount || 0) + 1;

      await idea.save();

      return res.json(
        idea.comments[idea.comments.length - 1]
      );
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        error: 'Internal server error'
      });
    }
  }
);

app.put(
  '/api/ideas/:postId/comments/:commentId',
  verifyToken,
  async (req, res) => {
    try {
      const idea = await Idea.findById(
        req.params.postId
      );

      if (!idea) {
        return res.status(404).json({
          error: 'Idea not found'
        });
      }

      const comment = idea.comments.id(
        req.params.commentId
      );

      if (!comment) {
        return res.status(404).json({
          error: 'Comment not found'
        });
      }

      if (comment.userId !== req.user.email) {
        return res.status(403).json({
          error: 'Forbidden'
        });
      }

      comment.text = req.body.text;

      await idea.save();

      return res.json(comment);
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        error: 'Internal server error'
      });
    }
  }
);

app.delete(
  '/api/ideas/:postId/comments/:commentId',
  verifyToken,
  async (req, res) => {
    try {
      const idea = await Idea.findById(
        req.params.postId
      );

      if (!idea) {
        return res.status(404).json({
          error: 'Idea not found'
        });
      }

      const comment = idea.comments.id(
        req.params.commentId
      );

      if (!comment) {
        return res.status(404).json({
          error: 'Comment not found'
        });
      }

      if (comment.userId !== req.user.email) {
        return res.status(403).json({
          error: 'Forbidden'
        });
      }

      idea.comments.pull(req.params.commentId);

      idea.interactionCount = Math.max(
        (idea.interactionCount || 0) - 1,
        0
      );

      await idea.save();

      return res.json({
        message: 'Comment deleted'
      });
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        error: 'Internal server error'
      });
    }
  }
);

app.get(
  '/api/users/:email/ideas',
  verifyToken,
  async (req, res) => {
    try {
      if (req.params.email !== req.user.email) {
        return res.status(403).json({
          error: 'Forbidden'
        });
      }

      const ideas = await Idea.find({
        creatorEmail: req.params.email
      }).sort({
        createdAt: -1
      });

      return res.json(ideas);
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        error: 'Server error'
      });
    }
  }
);

app.get(
  '/api/users/:email/interactions',
  verifyToken,
  async (req, res) => {
    try {
      if (req.params.email !== req.user.email) {
        return res.status(403).json({
          error: 'Forbidden'
        });
      }

      const ideas = await Idea.find({
        'comments.userId': req.params.email
      })
        .select(
          'title shortDescription creatorName comments category imageUrl createdAt'
        )
        .sort({
          createdAt: -1
        });

      return res.json(ideas);
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        error: 'Server error'
      });
    }
  }
);

async function startServer() {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000
    });

    console.log('MongoDB connected');

    auth = betterAuth({
      database: mongodbAdapter(
        mongoose.connection.db
      ),

      emailAndPassword: {
        enabled: true
      },

      socialProviders: {
        google: {
          clientId:
            process.env.GOOGLE_CLIENT_ID,
          clientSecret:
            process.env.GOOGLE_CLIENT_SECRET
        }
      },

      trustedOrigins: [
        FRONTEND_URL,
        'http://localhost:5173',
        'https://ideavault-frontend-1.onrender.com'
      ],

      advanced: {
        useSecureCookies: isProduction
      }
    });

    console.log('Better Auth initialized');

    if (isProduction) {
      const distPath = path.join(
        process.cwd(),
        'dist'
      );

      app.use(express.static(distPath));

      app.get('*', (req, res) => {
        const indexPath = path.join(
          distPath,
          'index.html'
        );

        if (fs.existsSync(indexPath)) {
          return res.sendFile(indexPath);
        }

        return res.status(404).json({
          error: 'Not Found'
        });
      });
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(
        `Server running on port ${PORT}`
      );
    });
  } catch (error) {
    console.error(
      'Critical startup error:',
      error
    );

    process.exit(1);
  }
}

startServer();