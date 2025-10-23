import express from 'express';
import emailChecker from '../services/emailChecker.js';
import Test from '../models/testsModel.js';

const router = express.Router();

// Start checking for test emails
router.post('/start-check', async (req, res) => {
  try {
    const { testId } = req.body;

    if (!testId) {
      return res.status(400).json({
        success: false,
        message: 'Test ID is required'
      });
    }

    const test = await Test.findOne({ testId });
    if (!test) {
      return res.status(404).json({
        success: false,
        message: 'Test not found'
      });
    }

    console.log(`Manual check triggered for test: ${testId}`);

    // Start checking in background (non-blocking)
    emailChecker.checkTestInboxes(testId).catch(console.error);

    res.json({
      success: true,
      message: 'Email checking started',
      data: {
        testId,
        estimatedTime: '2-5 minutes'
      }
    });
  } catch (error) {
    console.error('Error starting email check:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start email checking'
    });
  }
});

// Improved background job to process pending tests
const processPendingTests = async () => {
  try {
    console.log('Background job: Checking for pending tests...');
    
    // Find tests that are stuck in processing for too long (>10 minutes)
    const stuckTests = await Test.find({
      status: 'processing',
      startedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } // Older than 10 minutes
    });

    // Reset stuck tests
    for (const test of stuckTests) {
      console.log(`Resetting stuck test: ${test.testId}`);
      test.status = 'waiting';
      test.history.push({
        action: 'reset_stuck_test',
        details: { reason: 'Processing timeout', resetAt: new Date() }
      });
      await test.save();
    }

    // Find waiting tests (limit to 2 at a time)
    const waitingTests = await Test.find({
      status: 'waiting',
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours only
    }).limit(2);

    console.log(`Found ${waitingTests.length} waiting tests to process`);

    for (const test of waitingTests) {
      try {
        console.log(`Processing waiting test: ${test.testId}`);
        
        // Update status to processing immediately
        test.status = 'processing';
        test.startedAt = new Date();
        test.history.push({
          action: 'background_processing_started',
          details: { startedAt: test.startedAt }
        });
        await test.save();

        // Process the test
        await emailChecker.checkTestInboxes(test.testId);
        
        console.log(`Completed processing test: ${test.testId}`);
        
        // Add longer delay between tests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 45000)); // 45 seconds
        
      } catch (error) {
        console.error(` Error processing test ${test.testId}:`, error.message);
        
        // Mark test as failed on error
        const failedTest = await Test.findOne({ testId: test.testId });
        if (failedTest) {
          failedTest.status = 'failed';
          failedTest.history.push({
            action: 'background_processing_failed',
            details: { error: error.message, failedAt: new Date() }
          });
          await failedTest.save();
        }
      }
    }

    if (waitingTests.length === 0) {
      console.log('No pending tests to process');
    }

  } catch (error) {
    console.error('Background job error:', error);
  }
};

// // Run background job every 2 minutes (reduced frequency)
// setInterval(processPendingTests, 2 * 60 * 1000);

// // Initial delay for server startup
// setTimeout(processPendingTests, 15000);

export default router;