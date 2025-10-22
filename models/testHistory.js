import mongoose from "mongoose";


const testHistorySchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true
  },
  userEmail: {
    type: String,
    required: true
  },
  testId: {
    type: String,
    required: true
  },
  testCode: {
    type: String,
    required: true
  },
  overallScore: Number,
  deliveredCount: Number,
  spamCount: Number,
  totalTests: Number,
  results: [{
    emailProvider: String,
    folder: String,
    status: String
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  completedAt: Date
});

// Compound index for user history
testHistorySchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model('TestHistory', testHistorySchema);
