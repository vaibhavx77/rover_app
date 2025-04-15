require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

// Initialize Express
const app = express();
const server = createServer(app);

// Middleware
app.use(cors({
  origin: '*', // Replace '*' with your frontend URL in production
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json());

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/Rover';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err.message));

// Socket.IO Setup
const io = new Server(server, {
  cors: { 
    origin: '*',
    methods: ['GET', 'POST']
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  }
}); 

// MongoDB Schemas
const HazardSchema = new mongoose.Schema({
  type: { 
    type: String, 
    enum: ['speed_cam', 'police', 'accident', 'danger'],
    required: true
  },
  location: {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: { type: [Number], required: true }, // [longitude, latitude]
  },
  userId: { type: String, required: true },
  verifiedBy: [{ type: String }],
  createdAt: { type: Date, default: Date.now }
});

HazardSchema.index({ location: '2dsphere' });

const UserSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true },
  reportedHazards: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Hazard' }],
  createdAt: { type: Date, default: Date.now }
});

const Hazard = mongoose.model('Hazard', HazardSchema);
const User = mongoose.model('User', UserSchema);

// API Routes
app.get('/api/hazards', async (req, res) => {
  try {
    const { lat, lng, radius = 5000 } = req.query;
    const hazards = await Hazard.find({
      location: {
        $geoWithin: {
          $centerSphere: [[Number(lng), Number(lat)], radius / 6378.1] // Radius in radians
        }
      }
    }).limit(100);

    // Transform hazards
    const transformedHazards = hazards.map(hazard => ({
      id: hazard._id,
      type: hazard.type,
      location: {
        lat: hazard.location.coordinates[1], // Extract latitude
        lng: hazard.location.coordinates[0], // Extract longitude
      },
      verifiedBy: hazard.verifiedBy,
    }));

    res.json(transformedHazards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.IO Logic
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('join-location', async (data) => {
    const roomId = `${data.lat.toFixed(2)}_${data.lng.toFixed(2)}`;
    socket.join(roomId);
    console.log(`Socket ${socket.id} joined room ${roomId}`);
  });

  // Helper function to transform hazard format
  const transformHazard = (hazard) => ({
    id: hazard._id, // Rename _id to id
    type: hazard.type,
    location: {
      lat: hazard.location.coordinates[1], // Extract latitude
      lng: hazard.location.coordinates[0], // Extract longitude
    },
    verifiedBy: hazard.verifiedBy,
  });

  socket.on('report-hazard', async (data) => {
    try {
      // Validate hazard type
      if (!['speed_cam', 'police', 'accident', 'danger'].includes(data.type)) {
        throw new Error('Invalid hazard type');
      }

      // Validate location
      if (!data.location || !data.location.lat || !data.location.lng) {
        throw new Error('Invalid location data');
      }

      // Save hazard to the database
      const hazard = new Hazard({
        type: data.type,
        location: {
          type: 'Point',
          coordinates: [data.location.lng, data.location.lat],
        },
        userId: data.userId || 'anonymous', // Default to anonymous if no userId
      });

      await hazard.save();

      // Transform hazard before broadcasting
      const transformedHazard = transformHazard(hazard);

      // Broadcast the hazard to users in the same room
      const roomId = `${data.location.lat.toFixed(2)}_${data.location.lng.toFixed(2)}`;
      io.to(roomId).emit('new-hazard', transformedHazard);

      console.log(`New hazard reported: ${data.type} by ${data.userId || 'anonymous'}`);
    } catch (err) {
      socket.emit('error', err.message);
      console.error('Error reporting hazard:', err);
    }
  });

  socket.on('verify-hazard', async (data) => {
    try {
      const { hazardId, userId } = data;

      // Update the hazard's verifiedBy field
      const updatedHazard = await Hazard.findByIdAndUpdate(
        hazardId,
        { $addToSet: { verifiedBy: userId } }, // Add userId to verifiedBy array if not already present
        { new: true }
      );

      if (updatedHazard) {
        // Broadcast the updated hazard to all clients
        io.emit('hazard-updated', updatedHazard);
        console.log(`Hazard verified: ${hazardId} by ${userId}`);
      } else {
        console.error('Hazard not found:', hazardId);
      }
    } catch (err) {
      console.error('Error verifying hazard:', err);
    }
  });

  socket.on('delete-hazard', async (data) => {
    try {
      const { hazardId, userId } = data;

      const hazard = await Hazard.findById(hazardId);

      if (hazard && hazard.userId === userId) {
        await Hazard.findByIdAndDelete(hazardId);
        io.emit('hazard-deleted', { hazardId });
        console.log(`Hazard deleted: ${hazardId} by ${userId}`);
      } else {
        console.error('Unauthorized deletion attempt or hazard not found');
      }
    } catch (err) {
      console.error('Error deleting hazard:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Health Check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});