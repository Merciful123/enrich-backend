import mongoose from 'mongoose';
import env from "dotenv";

env.config()

const testResultSchema = new mongoose.Schema({
  emailProvider: {
    type: String,
    required: true,
    enum: ['gmail', 'outlook']
  },
  emailAddress: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'delivered', 'not_delivered', 'error'],
    default: 'pending'
  },
  folder: {
    type: String,
    enum: ['inbox', 'spam', 'promotions', 'social', 'updates', 'forums', 'not_found'],
    default: 'not_found'
  },
  subject: String,
  receivedAt: Date,
  checkedAt: Date,
  error: String
});

const testSchema = new mongoose.Schema({
  testId: {
    type: String,
    required: true,
    unique: true
  },
  testCode: {
    type: String,
    required: true,
    unique: true
  },
  userEmail: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  userName: String,
  status: {
    type: String,
    enum: ['created', 'waiting', 'processing', 'completed', 'failed', 'expired'],
    default: 'created'
  },
  results: [testResultSchema],
  overallScore: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },
  deliveredCount: {
    type: Number,
    default: 0
  },
  spamCount: {
    type: Number,
    default: 0
  },
  inboxCount: {  // Track inbox deliveries separately
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400
  },
  startedAt: Date,
  completedAt: Date,
  shareableLink: String,
  history: [{
    action: String,
    timestamp: {
      type: Date,
      default: Date.now
    },
    details: mongoose.Schema.Types.Mixed
  }]
});

//Correct pre-save middleware for score calculation
testSchema.pre('save', function(next) {
  if (this.results && this.results.length > 0) {
    // Count different types of results
    const deliveredResults = this.results.filter(r => r.status === 'delivered');
    const inboxResults = this.results.filter(r => r.folder === 'inbox');
    const spamResults = this.results.filter(r => r.folder === 'spam');
    
    // Update counts
    this.deliveredCount = deliveredResults.length;
    this.spamCount = spamResults.length;
    this.inboxCount = inboxResults.length;
    
    //  Calculate overall score based on inbox placements
    // Score = (number of inbox placements / total providers) * 100
    if (this.results.length > 0) {
      this.overallScore = Math.round((this.inboxCount / this.results.length) * 100);
    } else {
      this.overallScore = 0;
    }
    
    console.log(`Score Calculation: ${this.inboxCount} inbox / ${this.results.length} total = ${this.overallScore}%`);
  } else {
    // Reset counts if no results
    this.deliveredCount = 0;
    this.spamCount = 0;
    this.inboxCount = 0;
    this.overallScore = 0;
  }
  
  // Generate shareable link if not present
  if (!this.shareableLink && process.env.FRONTEND_URL) {
    this.shareableLink = `${process.env.FRONTEND_URL}/report/${this.testId}`;
  }
  
  next();
});

// Indexes
testSchema.index({ testCode: 1 });
testSchema.index({ testId: 1 });
testSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });
testSchema.index({ userEmail: 1, createdAt: -1 });

export default mongoose.model('Test', testSchema);