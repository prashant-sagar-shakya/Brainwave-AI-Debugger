import express from "express";
import User from "../models/User.js";

const router = express.Router();

// Register user with Clerk data
router.post("/register", async (req, res) => {
  try {
    const { email, clerkId, firstName, lastName, imageUrl } = req.body;
    const userExists = await User.findOne({ clerkId });

    if (userExists) {
      return res.status(400).json({ message: "User already exists" });
    }

    const user = await User.create({
      email,
      clerkId,
      firstName,
      lastName,
      imageUrl,
    });

    res.status(201).json({
      _id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get chat history

// Login user
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const token = jwt.sign({ userId: user._id }, import.meta.env.JWT_SECRET, {
      expiresIn: "24h",
    });

    res.json({
      _id: user._id,
      email: user.email,
      token,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get chat history

// Save chat message
router.post("/chat", async (req, res) => {
  try {
    const { userId, message } = req.body;
    const user = await User.findOne({ clerkId: userId });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.chatHistory.push(message);
    await user.save();

    res.status(201).json(message);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get chat history

// Get chat history with pagination
router.get("/chat/:userId", async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.params.userId });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const totalMessages = user.chatHistory.length;
    const messages = user.chatHistory
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(
        (req.query.page - 1) * req.query.limit,
        req.query.page * req.query.limit
      );

    res.json({
      messages,
      totalPages: Math.ceil(totalMessages / req.query.limit),
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
});

// Fetch user data
router.get("/user/:clerkId", async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.params.clerkId });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      _id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
    });
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
});

// New endpoint to clear chat history
router.delete("/chat/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    // Assuming you have a Chat model
    const user = await User.findOne({ clerkId: userId });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    user.chatHistory = [];
    await user.save();
    res.status(200).send("Chat history cleared");
  } catch (error) {
    console.error("Error clearing chat history:", error);
    res.status(500).send("Failed to clear chat history");
  }
});

export default router;
