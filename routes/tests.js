import express from 'express';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import Test from '../models/testsModel.js';
import env from "dotenv";

env.config()


const router = express.Router();

// Generate unique test code
const generateTestCode = () => {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
};

// Test inbox configuration
const TEST_INBOXES = [
  {
    provider: 'gmail',
    email: process.env.GMAIL_USER || 'test.gmail@yourdomain.com',
    displayName: 'Gmail'
  },
  {
    provider: 'outlook',
    email: process.env.OUTLOOK_USER || 'test.outlook@yourdomain.com',
    displayName: 'Outlook'
  },
  {
    provider: 'yahoo',
    email: process.env.YAHOO_USER || 'test.yahoo@yourdomain.com',
    displayName: 'Yahoo'
  },
];


// 
// Add CORS middleware for specific routes if needed
router.use((req, res, next) => {
  const allowedOrigins = [
    'https://enrich-client.netlify.app',
    'http://localhost:5173',
    'http://localhost:5174'
  ];
  
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  next();
});
// 


// Create a new email deliverability test
router.post('/create', [
  body('userEmail').isEmail().normalizeEmail(),
  body('userName').optional().trim().escape()
], async (req, res) => {
  try {
    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false,
        errors: errors.array() 
      });
    }

    const { userEmail, userName } = req.body;
    const testId = uuidv4();
    const testCode = generateTestCode();

    // Create test results array
    const results = TEST_INBOXES.map(inbox => ({
      emailProvider: inbox.provider,
      emailAddress: inbox.email,
      status: 'pending',
      folder: 'not_found'
    }));

    // Create new test
    const test = new Test({
      testId,
      testCode,
      userEmail,
      userName,
      results,
      status: 'waiting', // Changed from 'processing' to 'waiting'
      history: [{
        action: 'test_created',
        details: { userEmail, userName }
      }]
    });

    await test.save();

    // REMOVED: Manual email checker trigger - let background job handle it
    console.log(`Test created: ${testId}, waiting for background processing...`);

    res.status(201).json({
      success: true,
      message: 'Test created successfully',
      data: {
        testId,
        testCode,
        userEmail,
        userName,
        testInboxes: TEST_INBOXES.map(({ provider, displayName, email }) => ({
          provider,
          displayName,
          email
        })),
        shareableLink: test.shareableLink,
        createdAt: test.createdAt,
        status: 'waiting' // Inform frontend about the status
      }
    });

  } catch (error) {
    console.error('Error creating test:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to create test',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
// Get test report by test ID
router.get('/report/:testId', async (req, res) => {
  try {
    const { testId } = req.params;
    const test = await Test.findOne({ testId });
    
    if (!test) {
      return res.status(404).json({
        success: false,
        message: 'Test report not found'
      });
    }

    res.json({
      success: true,
      data: test
    });
  } catch (error) {
    console.error('Error fetching test report:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch test report'
    });
  }
});

// Get test status and results
router.get('/status/:testId', async (req, res) => {
  try {
    const { testId } = req.params;
    const test = await Test.findOne(
      { testId },
      'testId testCode status overallScore deliveredCount spamCount inboxCount results createdAt completedAt'
    );
    
    if (!test) {
      return res.status(404).json({
        success: false,
        message: 'Test not found'
      });
    }

    res.json({
      success: true,
      data: test
    });
  } catch (error) {
    console.error('Error fetching test status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch test status'
    });
  }
});

// Get test history for a user
router.get('/history/:userEmail', async (req, res) => {
  try {
    const { userEmail } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const tests = await Test.find({ userEmail })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('testId testCode status overallScore deliveredCount spamCount inboxCount  createdAt completedAt');

    const total = await Test.countDocuments({ userEmail });

    res.json({
      success: true,
      data: {
        tests,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error fetching test history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch test history'
    });
  }
});

// Generate PDF export for test report
router.post('/export-pdf/:testId', async (req, res) => {
  try {
    const { testId } = req.params;
    const test = await Test.findOne({ testId });
    
    if (!test) {
      return res.status(404).json({
        success: false,
        message: 'Test not found'
      });
    }

    const pdfData = {
      testId: test.testId,
      testCode: test.testCode,
      createdAt: test.createdAt,
      overallScore: test.overallScore,
      results: test.results,
      summary: {
        total: test.results.length,
        delivered: test.deliveredCount,
        spam: test.spamCount,
        inbox: test.results.filter(r => r.folder === 'inbox').length
      }
    };

    res.json({
      success: true,
      message: 'PDF export generated successfully',
      data: pdfData,
      downloadUrl: `/api/tests/download-pdf/${test.testId}`
    });

  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate PDF export'
    });
  }
});

export default router;