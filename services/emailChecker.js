import Imap from "imap";
import nodemailer from "nodemailer";
import Test from "../models/testsModel.js";
import env from "dotenv";

env.config();

class EmailChecker {
  constructor() {
    this.providers = {
      gmail: {
        imap: {
          host: "imap.gmail.com",
          port: 993,
          tls: true,
          tlsOptions: { rejectUnauthorized: false },
          authTimeout: 30000,
        },
        folders: ["INBOX", "[Gmail]/Spam", "[Gmail]/All Mail"],
      },
      outlook: {
        imap: {
          host: "outlook.office365.com",
          port: 993,
          tls: true,
          tlsOptions: { rejectUnauthorized: false },
          authTimeout: 30000,
        },
        folders: ["INBOX", "Junk Email"],
      }
    };

    //  Correct email configuration structure
    this.emailConfigs = {
      gmail: [
        {
          user: process.env.GMAIL_USER1?.replace(/"/g, ""),
          pass: process.env.GMAIL_PASS1?.replace(/"/g, ""),
        },
        {
          user: process.env.GMAIL_USER2?.replace(/"/g, ""),
          pass: process.env.GMAIL_PASS2?.replace(/"/g, ""),
        },
        {
          user: process.env.GMAIL_USER3?.replace(/"/g, ""),
          pass: process.env.GMAIL_PASS3?.replace(/"/g, ""),
        },
        {
          user: process.env.GMAIL_USER4?.replace(/"/g, ""),
          pass: process.env.GMAIL_PASS4?.replace(/"/g, ""),
        }
      ],
      outlook: [
        {
          user: process.env.OUTLOOK_USER?.replace(/"/g, ""),
          pass: process.env.OUTLOOK_PASS?.replace(/"/g, ""),
        }
      ]
    };

    this.validateConfig();
  }

  validateConfig() {
    console.log("\n ========== EMAIL CONFIGURATION VALIDATION ==========");

    Object.keys(this.emailConfigs).forEach((provider) => {
      const configs = this.emailConfigs[provider];
      console.log(` ${provider.toUpperCase()}: ${configs.length} accounts configured`);
      
      configs.forEach((config, index) => {
        if (!config.user || !config.pass) {
          console.log(` ${provider} Account ${index + 1}: Missing credentials`);
        } else if (config.pass.length < 10) {
          console.log(` ${provider} Account ${index + 1}: Password might be too short`);
        } else {
          console.log(` ${provider} Account ${index + 1}: ${config.user}`);
        }
      });
    });
    console.log(" =================================================\n");
  }

  //  Get email config by email address
  getEmailConfig(emailAddress) {
    for (const provider in this.emailConfigs) {
      const configs = this.emailConfigs[provider];
      const config = configs.find(c => c.user === emailAddress);
      if (config) {
        return { provider, config };
      }
    }
    return null;
  }

  async checkTestInboxes(testId) {
    console.log(`\n ========== STARTING EMAIL CHECK ==========`);
    console.log(` Test ID: ${testId}`);

    const test = await Test.findOne({ testId });
    if (!test) {
      console.log(` Test ${testId} not found in database`);
      return;
    }

    console.log(` Test Status: ${test.status}, Code: ${test.testCode}`);

    if (test.status === "processing") {
      const processingTime = new Date() - (test.startedAt || new Date());
      console.log(`⏳ Test ${testId} is already being processed (${Math.round(processingTime / 1000)}s ago)`);
      return;
    }

    try {
      test.status = "processing";
      test.startedAt = new Date();
      test.history.push({
        action: "processing_started",
        details: { startedAt: test.startedAt, testCode: test.testCode },
      });
      await test.save();

      console.log(`Starting email search for test code: ${test.testCode}`);

      let processedCount = 0;

      // FIXED: Process each result with proper email configuration
      for (const result of test.results) {
        const emailAddress = result.emailAddress;
        const emailConfigInfo = this.getEmailConfig(emailAddress);
        
        if (!emailConfigInfo) {
          console.log(` No configuration found for: ${emailAddress}`);
          await this.updateTestResult(
            testId,
            result.emailProvider,
            "error",
            "not_found",
            `No email configuration found for ${emailAddress}`
          );
          continue;
        }

        const { provider, config: emailConfig } = emailConfigInfo;
        const providerConfig = this.providers[provider];

        console.log(`\n --- Checking ${emailAddress} (${provider}) ---`);

        if (!providerConfig || !emailConfig?.user || !emailConfig?.pass) {
          console.log(` Skipping ${emailAddress} - credentials issue`);
          await this.updateTestResult(
            testId,
            result.emailProvider,
            "error",
            "not_found",
            "Email credentials not configured properly"
          );
          continue;
        }

        try {
          console.log(` Attempting IMAP connection to ${emailAddress}...`);
          await this.checkProvider(testId, emailAddress, provider, emailConfig);
          processedCount++;

          // Dynamic delay based on provider
          const delay = provider === "gmail" ? 3000 : 2000;
          console.log(` Waiting ${delay}ms before next check...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } catch (error) {
          console.error(` Error checking ${emailAddress}:`, error.message);
          await this.updateTestResult(
            testId,
            result.emailProvider,
            "error",
            "not_found",
            error.message
          );
        }
      }

      console.log(` Processed ${processedCount}/${test.results.length} email accounts`);

      // Calculate final score
      await this.calculateFinalScore(testId);

      // Mark test as completed
      const completedTest = await Test.findOne({ testId });
      if (completedTest) {
        completedTest.status = "completed";
        completedTest.completedAt = new Date();
        const duration = completedTest.completedAt - completedTest.startedAt;

        completedTest.history.push({
          action: "processing_completed",
          details: {
            completedAt: completedTest.completedAt,
            duration: duration,
            processedProviders: processedCount,
          },
        });
        await completedTest.save();

        // Send completion email
        await this.sendCompletionEmail(completedTest);
        console.log(` Email check completed for test ${testId} in ${Math.round(duration / 1000)}s`);
      }
    } catch (error) {
      console.error(`Critical error checking inboxes for test ${testId}:`, error);
      const failedTest = await Test.findOne({ testId });
      if (failedTest) {
        failedTest.status = "failed";
        failedTest.history.push({
          action: "processing_failed",
          details: {
            error: error.message,
            failedAt: new Date(),
          },
        });
        await failedTest.save();
      }
    }

    console.log(` ========== EMAIL CHECK COMPLETED ==========\n`);
  }

  //Updated checkProvider to accept specific email config
  async checkProvider(testId, emailAddress, provider, emailConfig) {
    return new Promise((resolve, reject) => {
      const providerConfig = this.providers[provider];
      if (!providerConfig) {
        return reject(new Error(`No provider configuration for ${provider}`));
      }

      const config = { ...providerConfig.imap };
      
      console.log(` Connecting to ${emailAddress} (${provider})...`);

      config.user = emailConfig.user;
      config.password = emailConfig.pass;

      const imap = new Imap(config);

      imap.once("ready", () => {
        console.log(`Connected to ${emailAddress} successfully`);
        this.searchEmails(
          imap,
          testId,
          emailAddress,
          provider,
          providerConfig.folders
        )
          .then(resolve)
          .catch(reject)
          .finally(() => {
            console.log(` Closing IMAP connection for ${emailAddress}`);
            imap.end();
          });
      });

      imap.once("error", (err) => {
        console.error(`IMAP connection error for ${emailAddress}:`, err);
        
        // Enhanced error logging
        if (err.source === 'authentication') {
          console.error(` AUTHENTICATION FAILED for ${emailAddress}`);
          console.error(` Username: ${emailConfig.user}`);
          console.error(` Password length: ${emailConfig.pass?.length} chars`);
          console.error(` Solution: Use App Password instead of regular password`);
        }
        
        this.updateTestResult(
          testId,
          provider,
          "error",
          "not_found",
          err.message
        ).finally(() => reject(err));
      });

      imap.once("end", () => {
        console.log(` IMAP connection ended for ${emailAddress}`);
      });

      // Connection timeout
      const timeout = setTimeout(() => {
        console.error(` IMAP connection timeout for ${emailAddress}`);
        imap.end();
        reject(new Error(`Connection timeout for ${emailAddress} (30s)`));
      }, 30000);

      imap.once("ready", () => clearTimeout(timeout));

      console.log(`Initiating IMAP connection to ${config.host}:${config.port}`);
      imap.connect();
    });
  }

  // FIXED: Updated searchEmails to include emailAddress
  async searchEmails(imap, testId, emailAddress, provider, folders) {
    const test = await Test.findOne({ testId });
    if (!test) {
      throw new Error(`Test ${testId} not found`);
    }

    let emailFound = false;
    const testCode = test.testCode;

    console.log(` Searching for code: "${testCode}" in ${emailAddress}`);

    for (const folder of folders) {
      if (emailFound) {
        console.log(`Skipping ${folder} - email already found`);
        break;
      }

      try {
        console.log(` Checking folder: ${folder}`);
        await this.openFolder(imap, folder);
        const emails = await this.searchInFolder(imap, testCode);

        if (emails && emails.length > 0) {
          console.log(`Found ${emails.length} matching emails in ${folder}`);

          try {
            const emailData = await this.fetchEmail(imap, emails[0]);
            const folderName = this.mapFolderName(folder, provider);

            await this.updateTestResult(
              testId,
              provider,
              "delivered",
              folderName,
              null,
              emailData.subject,
              emailData.receivedAt,
              emailAddress // Pass email address to identify which account
            );

            emailFound = true;
            console.log(` Email delivered to ${emailAddress} in ${folderName}`);
          } catch (fetchError) {
            console.error(`Error fetching email:`, fetchError.message);
            // Still mark as delivered since we found the email
            await this.updateTestResult(
              testId,
              provider,
              "delivered",
              this.mapFolderName(folder, provider),
              null,
              null,
              null,
              emailAddress
            );
            emailFound = true;
          }
        } else {
          console.log(` No matching emails found in ${folder}`);
        }
      } catch (error) {
        console.error(` Error in folder ${folder}:`, error.message);
      }
    }

    if (!emailFound) {
      console.log(` No email found in ${emailAddress} across all folders`);
      await this.updateTestResult(
        testId,
        provider,
        "not_delivered",
        "not_found",
        null,
        null,
        null,
        emailAddress
      );
    }
  }

  // Updated updateTestResult to handle specific email addresses
  async updateTestResult(
    testId,
    provider,
    status,
    folder,
    error = null,
    subject = null,
    receivedAt = null,
    emailAddress = null
  ) {
    try {
      const test = await Test.findOne({ testId });
      if (!test) {
        console.log(` Test ${testId} not found when updating result`);
        return;
      }

      // Find the result by email address if provided, otherwise by provider
      let result;
      if (emailAddress) {
        result = test.results.find((r) => r.emailAddress === emailAddress);
      } else {
        result = test.results.find((r) => r.emailProvider === provider);
      }

      if (result) {
        console.log(`Updating ${emailAddress || provider}: ${status} in ${folder}`);
        result.status = status;
        result.folder = folder;
        result.checkedAt = new Date();
        if (error) result.error = error;
        if (subject) result.subject = subject;
        if (receivedAt) result.receivedAt = receivedAt;

        await test.save();
        console.log(`Updated ${emailAddress || provider} result: ${status} in ${folder}`);
      } else {
        console.log(` Result not found for ${emailAddress || provider}`);
      }
    } catch (error) {
      console.error(` Error updating test result for ${emailAddress || provider}:`, error);
    }
  }

  async openFolder(imap, folder) {
    return new Promise((resolve, reject) => {
      const cleanFolder = folder.replace(/"/g, "");

      imap.openBox(cleanFolder, false, (err, box) => {
        if (err) {
          console.error(` Failed to open folder "${cleanFolder}":`, err.message);
          reject(err);
        } else {
          console.log(`Opened folder: ${cleanFolder} (${box.messages.total} messages)`);
          resolve(box);
        }
      });
    });
  }

  async searchInFolder(imap, testCode) {
    return new Promise((resolve, reject) => {
      if (!testCode || typeof testCode !== "string") {
        return reject(new Error("Invalid test code: " + testCode));
      }

      console.log(` IMAP Search for: "${testCode}"`);

      const searchCriteria = [["TEXT", testCode]];

      imap.search(searchCriteria, (err, results) => {
        if (err) {
          console.error(" IMAP Search error:", err);
          reject(err);
        } else {
          console.log(` Search results: ${results?.length || 0} emails found`);
          resolve(results || []);
        }
      });
    });
  }

  async fetchEmail(imap, uid) {
    return new Promise((resolve, reject) => {
      const fetch = imap.fetch(uid, {
        bodies: ["HEADER", "TEXT"],
        struct: true,
      });

      let emailData = {
        subject: "",
        receivedAt: new Date(),
      };

      fetch.on("message", (msg) => {
        msg.on("body", (stream, info) => {
          let buffer = "";
          stream.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
          });
          stream.on("end", () => {
            if (info.which === "HEADER") {
              const headers = Imap.parseHeader(buffer);
              emailData.subject = headers.subject?.[0] || "No Subject";
              console.log(` Email Subject: ${emailData.subject}`);
            }
          });
        });

        msg.once("attributes", (attrs) => {
          if (attrs.date) {
            emailData.receivedAt = attrs.date;
            console.log(` Email Date: ${attrs.date}`);
          }
        });
      });

      fetch.once("error", (err) => {
        console.error(" Email fetch error:", err);
        resolve(emailData);
      });

      fetch.once("end", () => {
        console.log(" Email fetch completed");
        resolve(emailData);
      });
    });
  }

  mapFolderName(folder, provider) {
    const folderMaps = {
      gmail: {
        INBOX: "inbox",
        "[Gmail]/Spam": "spam",
        "[Gmail]/All Mail": "all_mail",
      },
      outlook: {
        INBOX: "inbox",
        "Junk Email": "spam",
        Junk: "spam",
        Clutter: "promotions",
      }
    };

    const providerMap = folderMaps[provider] || {};
    const mappedFolder = providerMap[folder] || "other";

    console.log(` Folder mapping: ${folder} → ${mappedFolder}`);
    return mappedFolder;
  }

  async calculateFinalScore(testId) {
    try {
      const test = await Test.findOne({ testId });
      if (!test) {
        console.log(" Test not found for score calculation");
        return;
      }

      const totalProviders = test.results.length;
      const inboxDeliveries = test.results.filter(
        (r) => r.status === "delivered" && r.folder === "inbox"
      ).length;

      const spamDeliveries = test.results.filter(
        (r) => r.status === "delivered" && r.folder === "spam"
      ).length;

      const errorCount = test.results.filter(
        (r) => r.status === "error"
      ).length;

      const notDeliveredCount = test.results.filter(
        (r) => r.status === "not_delivered"
      ).length;

      // IMPROVED: Better score calculation
      const baseScore = (inboxDeliveries / totalProviders) * 100;
      const spamPenalty = (spamDeliveries / totalProviders) * 30; // Reduced penalty
      const errorPenalty = (errorCount / totalProviders) * 15; // Reduced penalty

      const finalScore = Math.max(0, Math.round(baseScore - spamPenalty - errorPenalty));

      test.overallScore = finalScore;
      await test.save();

      console.log(`\n ========== SCORE CALCULATION ==========`);
      console.log(` Inbox Deliveries: ${inboxDeliveries}/${totalProviders}`);
      console.log(` Spam Deliveries: ${spamDeliveries}/${totalProviders}`);
      console.log(` Errors: ${errorCount}/${totalProviders}`);
      console.log(` Not Delivered: ${notDeliveredCount}/${totalProviders}`);
      console.log(` Final Score: ${finalScore}%`);
      console.log(` ======================================\n`);
    } catch (error) {
      console.error(" Error calculating score:", error);
    }
  }

  async sendCompletionEmail(test) {
    try {
      if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log(" SMTP not configured, skipping completion email");
        return;
      }

      console.log(`Preparing completion email for: ${test.userEmail}`);

      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: process.env.SMTP_PORT || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.verify();
      console.log(" SMTP connection verified");

      const emailHtml = this.generateCompletionEmailHtml(test);

      await transporter.sendMail({
        from: `"Email Spam Report Tool" <${process.env.SMTP_USER}>`,
        to: test.userEmail,
        subject: `Your Email Deliverability Report - Score: ${test.overallScore}%`,
        html: emailHtml,
        text: `Your email deliverability test is complete. Score: ${test.overallScore}%. View full report: ${test.shareableLink}`,
      });

      console.log(` Completion email sent to ${test.userEmail}`);
    } catch (error) {
      console.error(" Error sending completion email:", error.message);
    }
  }

  generateCompletionEmailHtml(test) {
    const inboxCount = test.results.filter((r) => r.folder === "inbox").length;
    const spamCount = test.results.filter((r) => r.folder === "spam").length;
    const errorCount = test.results.filter((r) => r.status === "error").length;
    const notDeliveredCount = test.results.filter(
      (r) => r.status === "not_delivered"
    ).length;

    return `
      <!DOCTYPE html>
      <html>
      <head>
          <style>
              body { font-family: Arial, sans-serif; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: #4F46E5; color: white; padding: 20px; text-align: center; }
              .content { padding: 20px; background: #f9f9f9; }
              .results { margin: 20px 0; }
              .result-item { padding: 10px; margin: 5px 0; background: white; border-radius: 5px; }
              .inbox { border-left: 4px solid #10B981; }
              .spam { border-left: 4px solid #EF4444; }
              .error { border-left: 4px solid #6B7280; }
              .not-delivered { border-left: 4px solid #F59E0B; }
              .score { font-size: 24px; font-weight: bold; color: #4F46E5; text-align: center; margin: 20px 0; }
              .button { display: inline-block; padding: 12px 24px; background: #4F46E5; color: white; text-decoration: none; border-radius: 5px; }
          </style>
      </head>
      <body>
          <div class="container">
              <div class="header">
                  <h1>Email Deliverability Report Ready</h1>
              </div>
              <div class="content">
                  <p>Hello ${test.userName || "there"},</p>
                  <p>Your email deliverability test has been completed. Here's a quick summary:</p>
                  
                  <div class="score">
                      Deliverability Score: ${test.overallScore}%
                  </div>
                  
                  <div class="results">
                      <h3>Detailed Results:</h3>
                      ${test.results
                        .map(
                          (result) => `
                          <div class="result-item ${
                            result.folder === "inbox"
                              ? "inbox"
                              : result.folder === "spam"
                              ? "spam"
                              : result.status === "error"
                              ? "error"
                              : "not-delivered"
                          }">
                              <strong>${result.emailProvider.toUpperCase()}:</strong> 
                              ${result.emailAddress}<br>
                              ${
                                result.status === "delivered"
                                  ? " Delivered"
                                  : result.status === "error"
                                  ? " Error"
                                  : " Not Delivered"
                              }
                              ${
                                result.status === "delivered"
                                  ? ` (${result.folder})`
                                  : ""
                              }
                              ${
                                result.error
                                  ? `<br><small>Error: ${result.error}</small>`
                                  : ""
                              }
                          </div>
                      `
                        )
                        .join("")}
                  </div>
                  
                  <p><strong>Summary:</strong> ${inboxCount} inbox, ${spamCount} spam, ${errorCount} errors, ${notDeliveredCount} not delivered</p>
                  
                  <p style="text-align: center; margin: 30px 0;">
                      <a href="${test.shareableLink}" class="button" style="color:white">View Full Report</a>
                  </p>
                  
                  <p>Thank you for using our Email Spam Report Tool!</p>
              </div>
          </div>
      </body>
      </html>
    `;
  }
}

export default new EmailChecker();