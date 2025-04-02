import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db.js";
import userRoutes from "./routes/userRoutes.js";

dotenv.config();

const app = express();

// Connect to MongoDB
connectDB();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/users", userRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: "Something went wrong!" });
});

const PORT = process.env.PORT || 5000;
const MAX_PORT_ATTEMPTS = 10;

const startServer = async (initialPort) => {
  let currentPort = initialPort;

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const server = app.listen(currentPort, () => {
          console.log(`Server running on port ${currentPort}`);
          resolve();
        });

        server.on("error", (error) => {
          if (error.code === "EADDRINUSE") {
            console.log(
              `Port ${currentPort} is in use, trying ${currentPort + 1}...`
            );
            currentPort++;
            reject(error);
          } else {
            reject(error);
          }
        });
      });
      return; // Server started successfully
    } catch (error) {
      if (attempt === MAX_PORT_ATTEMPTS - 1) {
        console.error(
          "Could not find an available port after multiple attempts"
        );
        process.exit(1);
      }
    }
  }
};

startServer(PORT);
