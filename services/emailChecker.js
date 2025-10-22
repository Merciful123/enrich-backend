import Imap from "imap";
import { simpleParser } from "mailparser";
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
        folders: ["INBOX", "Junk Email"], // folder name
      },
      yahoo: {
        imap: {
          host: "imap.mail.yahoo.com",
          port: 993,
          tls: true,
          tlsOptions: { rejectUnauthorized: false },
          authTimeout: 30000,
        },
        folders: ["INBOX", "Bulk Mail"],
      },
    };

    // Remove quotes from passwords and validate
    this.emailConfigs = {
      gmail: {
        user: process.env.GMAIL_USER?.replace(/"/g, ""),
        pass: process.env.GMAIL_PASS?.replace(/"/g, ""),
      },
      outlook: {
        user: process.env.OUTLOOK_USER?.replace(/"/g, ""),
        pass: process.env.OUTLOOK_PASS?.replace(/"/g, ""),
      },
      yahoo: {
        user: process.env.YAHOO_USER?.replace(/"/g, ""),
        pass: process.env.YAHOO_PASS?.replace(/"/g, ""),
      },
    };

    this.validateConfig();
  }

  validateConfig() {
    console.log("\n ========== EMAIL CONFIGURATION VALIDATION ==========");

    Object.keys(this.emailConfigs).forEach((provider) => {
      const config = this.emailConfigs[provider];
      if (!config.user || !config.pass) {
        console.log(`${provider.toUpperCase()}: Missing credentials`);
      } else if (config.pass.length < 10) {
        console.log(
          ` ${provider.toUpperCase()}: Password too short (${
            config.pass.length
          } chars) - use app password`
        );
      } else {
        console.log(
          ` ${provider.toUpperCase()}: Configured (User: ${config.user})`
        );
      }
    });
    console.log(" =================================================\n");
  }

  async checkTestInboxes(testId) {
    console.log(`\n ========== STARTING EMAIL CHECK ==========`);
    console.log(` Test ID: ${testId}`);

    const test = await Test.findOne({ testId });
    if (!test) {
      console.log(`Test ${testId} not found in database`);
      return;
    }

    console.log(` Test Status: ${test.status}, Code: ${test.testCode}`);

    // Enhanced duplicate processing prevention
    if (test.status === "processing") {
      const processingTime = new Date() - (test.startedAt || new Date());
      console.log(
        `Test ${testId} is already being processed (${Math.round(
          processingTime / 1000
        )}s ago)`
      );
      return;
    }

    try {
      // Update test status
      test.status = "processing";
      test.startedAt = new Date();
      test.history.push({
        action: "processing_started",
        details: { startedAt: test.startedAt, testCode: test.testCode },
      });
      await test.save();

      console.log(`Starting email search for test code: ${test.testCode}`);

     
      let processedCount = 0;

      for (const result of test.results) {
        const provider = result.emailProvider;
        const providerConfig = this.providers[provider];
        const emailConfig = this.emailConfigs[provider];

        console.log(`\n --- Checking ${provider.toUpperCase()} ---`);
        console.log(` Account: ${emailConfig?.user}`);

        if (!providerConfig || !emailConfig?.user || !emailConfig?.pass) {
          console.log(
            `Skipping ${provider} - credentials not configured properly`
          );
          await this.updateTestResult(
            testId,
            provider,
            "error",
            "not_found",
            "Email credentials not configured"
          );
          continue;
        }

        try {
          console.log(` Attempting IMAP connection to ${provider}...`);
          await this.checkProvider(testId, provider);
          processedCount++;

          // Dynamic delay based on provider
          const delay = provider === "gmail" ? 5000 : 3000;
          console.log(` Waiting ${delay}ms before next provider...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } catch (error) {
          console.error(` Error checking ${provider}:`, error.message);
          await this.updateTestResult(
            testId,
            provider,
            "error",
            "not_found",
            error.message
          );
        }
      }

      console.log(
        ` Processed ${processedCount}/${test.results.length} providers`
      );

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
            // emailsSent: emailsSent,
          },
        });
        await completedTest.save();

        // Send completion email
        await this.sendCompletionEmail(completedTest);
        console.log(
          ` Email check completed for test ${testId} in ${Math.round(
            duration / 1000
          )}s`
        );
      }
    } catch (error) {
      console.error(
        ` Critical error checking inboxes for test ${testId}:`,
        error
      );
      const failedTest = await Test.findOne({ testId });
      if (failedTest) {
        failedTest.status = "failed";
        failedTest.history.push({
          action: "processing_failed",
          details: {
            error: error.message,
            // stack: error.stack,
            failedAt: new Date(),
          },
        });
        await failedTest.save();
      }
    }

    console.log(` EMAIL CHECK COMPLETED\n`);
  }

  async checkProvider(testId, provider) {
    return new Promise((resolve, reject) => {
      const config = { ...this.providers[provider].imap };
      const emailConfig = this.emailConfigs[provider];

      console.log(`Connecting to ${provider} as ${emailConfig.user}...`);

      config.user = emailConfig.user;
      config.password = emailConfig.pass;

      const imap = new Imap(config);

      imap.once("ready", () => {
        console.log(`Connected to ${provider} successfully`);
        this.searchEmails(
          imap,
          testId,
          provider,
          this.providers[provider].folders
        )
          .then(resolve)
          .catch(reject)
          .finally(() => {
            console.log(` Closing IMAP connection for ${provider}`);
            imap.end();
          });
      });

      imap.once("error", (err) => {
        console.error(` IMAP connection error for ${provider}:`, err.message);
        this.updateTestResult(
          testId,
          provider,
          "error",
          "not_found",
          err.message
        ).finally(() => reject(err));
      });

      imap.once("end", () => {
        console.log(`IMAP connection ended for ${provider}`);
      });

      // Connection timeout
      const timeout = setTimeout(() => {
        console.error(` IMAP connection timeout for ${provider}`);
        imap.end();
        reject(new Error(`Connection timeout for ${provider} (30s)`));
      }, 30000);

      imap.once("ready", () => clearTimeout(timeout));

      console.log(
        ` Initiating IMAP connection to ${config.host}:${config.port}`
      );
      imap.connect();
    });
  }

  async searchEmails(imap, testId, provider, folders) {
    const test = await Test.findOne({ testId });
    if (!test) {
      throw new Error(`Test ${testId} not found`);
    }

    let emailFound = false;
    const testCode = test.testCode;

    console.log(`Searching for code: "${testCode}" in ${provider}`);

    for (const folder of folders) {
      if (emailFound) {
        console.log(` Skipping ${folder} - email already found`);
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
              emailData.receivedAt
            );

            emailFound = true;
            console.log(` Email delivered to ${provider} ${folderName}`);
          } catch (fetchError) {
            console.error(` Error fetching email:`, fetchError.message);
            // Still mark as delivered since we found the email
            await this.updateTestResult(
              testId,
              provider,
              "delivered",
              this.mapFolderName(folder, provider)
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
      console.log(` No email found in ${provider} across all folders`);
      await this.updateTestResult(
        testId,
        provider,
        "not_delivered",
        "not_found"
      );
    }
  }

  async openFolder(imap, folder) {
    return new Promise((resolve, reject) => {
      // Clean folder name for Gmail
      const cleanFolder = folder.replace(/"/g, "");

      imap.openBox(cleanFolder, false, (err, box) => {
        if (err) {
          console.error(
            ` Failed to open folder "${cleanFolder}":`,
            err.message
          );
          reject(err);
        } else {
          console.log(
            `Opened folder: ${cleanFolder} (${box.messages.total} messages)`
          );
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

      //  Correct search criteria format for node-imap
      const searchCriteria = [["TEXT", testCode]];

      imap.search(searchCriteria, (err, results) => {
        if (err) {
          console.error("IMAP Search error:", err);
          reject(err);
        } else {
          console.log(
            `Search results: ${results?.length || 0} emails found`
          );
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
        resolve(emailData); // Still resolve with basic data
      });

      fetch.once("end", () => {
        console.log("Email fetch completed");
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
        "Junk Email": "spam", //Outlook folder name
        Junk: "spam",
        Clutter: "promotions",
      },
      yahoo: {
        INBOX: "inbox",
        "Bulk Mail": "spam",
      },
    };

    const providerMap = folderMaps[provider] || {};
    const mappedFolder = providerMap[folder] || "other";

    console.log(` Folder mapping: ${folder} → ${mappedFolder}`);
    return mappedFolder;
  }

  async updateTestResult(
    testId,
    provider,
    status,
    folder,
    error = null,
    subject = null,
    receivedAt = null
  ) {
    try {
      const test = await Test.findOne({ testId });
      if (!test) {
        console.log(`Test ${testId} not found when updating result`);
        return;
      }

      const result = test.results.find((r) => r.emailProvider === provider);
      if (result) {
        console.log(` Updating ${provider}: ${status} in ${folder}`);
        result.status = status;
        result.folder = folder;
        result.checkedAt = new Date();
        if (error) result.error = error;
        if (subject) result.subject = subject;
        if (receivedAt) result.receivedAt = receivedAt;

        await test.save();
        console.log(` Updated ${provider} result: ${status} in ${folder}`);
      }
    } catch (error) {
      console.error(` Error updating test result for ${provider}:`, error);
    }
  }

  async calculateFinalScore(testId) {
    try {
      const test = await Test.findOne({ testId });
      if (!test) {
        console.log("Test not found for score calculation");
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

      // Calculate score
      const inboxScore = (inboxDeliveries / totalProviders) * 100;
      const spamPenalty = (spamDeliveries / totalProviders) * 50;
      const errorPenalty = (errorCount / totalProviders) * 25;

      const finalScore = Math.max(
        0,
        Math.round(inboxScore - spamPenalty - errorPenalty)
      );

      test.overallScore = finalScore;
      await test.save();

      console.log(`\n  SCORE CALCULATION`);
      console.log(` Inbox: ${inboxDeliveries}/${totalProviders}`);
      console.log(` Spam: ${spamDeliveries}/${totalProviders}`);
      console.log(` Errors: ${errorCount}/${totalProviders}`);
      console.log(` Not Delivered: ${notDeliveredCount}/${totalProviders}`);
      console.log(` Final Score: ${finalScore}%`);
      console.log(` \n`);
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

      console.log(` Preparing completion email for: ${test.userEmail}`);

      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: process.env.SMTP_PORT || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      // Verify SMTP connection
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
                              ${
                                result.status === "delivered"
                                  ? " Delivered"
                                  : result.status === "error"
                                  ? " Error"
                                  : " Not Delivered"
                              }
                              ${
                                result.status === "delivered"
                                  ? `( ${result.folder})`
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
                      <a href="${
                        test.shareableLink
                      }" class="button" style="color:white">View Full Report</a>
                  </p>
                  
                  <p>Thank you for using our Email Spam Report Tool!</p>
              </div>
          </div>
      </body>
      </html>
    `;
  }

  async checkProvider(testId, provider) {
  return new Promise((resolve, reject) => {
    const config = { ...this.providers[provider].imap };
    const emailConfig = this.emailConfigs[provider];

    console.log(` Connecting to ${provider} as ${emailConfig.user}...`);

    config.user = emailConfig.user;
    config.password = emailConfig.pass;

    const imap = new Imap(config);

    imap.once("ready", () => {
      console.log(`Connected to ${provider} successfully`);
      this.searchEmails(
        imap,
        testId,
        provider,
        this.providers[provider].folders
      )
        .then(resolve)
        .catch(reject)
        .finally(() => {
          console.log(`Closing IMAP connection for ${provider}`);
          imap.end();
        });
    });

    imap.once("error", (err) => {
      console.error(`IMAP connection error for ${provider}:`, err);
      
      // Enhanced error logging
      if (err.source === 'authentication') {
        console.error(` AUTHENTICATION FAILED for ${provider}`);
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
      console.log(` IMAP connection ended for ${provider}`);
    });

    // Connection timeout
    const timeout = setTimeout(() => {
      console.error(` IMAP connection timeout for ${provider}`);
      imap.end();
      reject(new Error(`Connection timeout for ${provider} (30s)`));
    }, 30000);

    imap.once("ready", () => clearTimeout(timeout));

    console.log(
      ` Initiating IMAP connection to ${config.host}:${config.port}`
    );
    imap.connect();
  });
}

}

export default new EmailChecker();
