import mongoose from "mongoose";

const chatMessageSchema = new mongoose.Schema({
  sender: { type: String, required: true },
  text: { type: String, required: true },
  isMarkdown: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now },
});

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true },
    clerkId: { type: String, required: true, unique: true },
    firstName: { type: String },
    lastName: { type: String },
    imageUrl: { type: String },
    chatHistory: [chatMessageSchema],
    createdAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

// Add index for chat history timestamp and clerkId
userSchema.index({ "chatHistory.timestamp": -1 });
userSchema.index({ clerkId: 1 });

export default mongoose.model("User", userSchema);
