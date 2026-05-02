const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// Verify connection on startup
transporter.verify((error) => {
    if (error) {
        console.error("❌ Email transporter error:", error.message);
    } else {
        console.log("✅ Email transporter ready — connected to Gmail");
    }
});

// Generic send function
const sendEmail = async (to, subject, html, text) => {
    const mailOptions = {
        from: `"AI Vision QC" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        text: text || subject,
        html,
    };
    await transporter.sendMail(mailOptions);
    console.log("✅ Email sent to:", to);
};

// Scenario 1: Registration — sent to the new user
const sendPendingEmail = (email) => {
    const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;background:#f8fafc;border-radius:12px;overflow:hidden;border:1px solid #dde3ef">
      <div style="background:linear-gradient(90deg,#4361ee,#7c3aed);padding:28px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:800;letter-spacing:-.3px">AI Vision QC</h1>
        <p style="margin:4px 0 0;color:rgba(255,255,255,.75);font-size:12px;letter-spacing:.12em;text-transform:uppercase">Intelligent Quality Control</p>
      </div>
      <div style="padding:32px">
        <h2 style="margin:0 0 8px;color:#1a2233;font-size:18px">Account Pending Approval</h2>
        <p style="color:#6b7ea0;font-size:14px;line-height:1.6;margin:0 0 20px">
          We received your registration request. Your account is currently under review by the administrator.
          You will receive another email once your account has been approved.
        </p>
        <div style="background:#fff;border:1px solid #dde3ef;border-radius:8px;padding:16px 20px;font-size:13px;color:#6b7ea0">
          📧 Registered as: <strong style="color:#1a2233">${email}</strong>
        </div>
      </div>
      <div style="padding:16px 32px;border-top:1px solid #eef1f7;font-size:11px;color:#b0bec5;text-align:center">
        © ${new Date().getFullYear()} AI Vision QC — Smart Quality Control System
      </div>
    </div>`;
    return sendEmail(email, "Account Pending Approval", html,
        "We received your registration. Please wait for admin approval.");
};

// Scenario 2: Approval — sent to the user
const sendApprovedEmail = (email) => {
    const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;background:#f8fafc;border-radius:12px;overflow:hidden;border:1px solid #dde3ef">
      <div style="background:linear-gradient(90deg,#4361ee,#7c3aed);padding:28px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:800;letter-spacing:-.3px">AI Vision QC</h1>
        <p style="margin:4px 0 0;color:rgba(255,255,255,.75);font-size:12px;letter-spacing:.12em;text-transform:uppercase">Intelligent Quality Control</p>
      </div>
      <div style="padding:32px">
        <div style="text-align:center;margin-bottom:24px">
          <div style="width:52px;height:52px;background:#dcfce7;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:24px">✅</div>
        </div>
        <h2 style="margin:0 0 8px;color:#1a2233;font-size:18px;text-align:center">Account Approved!</h2>
        <p style="color:#6b7ea0;font-size:14px;line-height:1.6;margin:0 0 20px;text-align:center">
          Welcome! Your account has been verified by the administrator.<br>You can now log in to the system.
        </p>
        <div style="text-align:center">
          <a href="#" style="display:inline-block;background:linear-gradient(90deg,#4361ee,#7c3aed);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:.04em">Sign In Now</a>
        </div>
      </div>
      <div style="padding:16px 32px;border-top:1px solid #eef1f7;font-size:11px;color:#b0bec5;text-align:center">
        © ${new Date().getFullYear()} AI Vision QC — Smart Quality Control System
      </div>
    </div>`;
    return sendEmail(email, "Account Approved — You can now log in", html,
        "Your account has been verified. You can now log in.");
};

// Scenario 3: Danger alert — sent to all workers & admins
const sendDangerAlert = async (recipientEmails = []) => {
    if (!recipientEmails.length) return;

    const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff0f0;border-radius:12px;overflow:hidden;border:2px solid #f87171">
      <div style="background:linear-gradient(90deg,#dc2626,#b91c1c);padding:28px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:800;letter-spacing:-.3px">⚠ AI Vision QC — DANGER ALERT</h1>
        <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:12px;letter-spacing:.12em;text-transform:uppercase">Emergency Notification</p>
      </div>
      <div style="padding:32px">
        <div style="text-align:center;margin-bottom:20px">
          <div style="width:60px;height:60px;background:#fee2e2;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:30px">🚨</div>
        </div>
        <h2 style="margin:0 0 12px;color:#991b1b;font-size:18px;text-align:center">System in Danger!</h2>
        <p style="color:#7f1d1d;font-size:15px;line-height:1.7;margin:0 0 20px;text-align:center;font-weight:500">
          Please check your app, the system is in danger!
        </p>
        <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:16px 20px;font-size:13px;color:#991b1b;text-align:center">
          Open the app immediately and check the <strong>Error Logs</strong> section for details.
        </div>
      </div>
      <div style="padding:16px 32px;border-top:1px solid #fca5a5;font-size:11px;color:#b0bec5;text-align:center">
        © ${new Date().getFullYear()} AI Vision QC — Smart Quality Control System
      </div>
    </div>`;

    const promises = recipientEmails.map(email =>
        sendEmail(email, "⚠ DANGER ALERT — Check Your App Immediately", html,
            "Please check your app, the system is in danger!")
    );

    await Promise.allSettled(promises);
    console.log(`[Email] Danger alert sent to ${recipientEmails.length} recipient(s)`);
};

// Scenario 4: System error alert — sent only to currently-online workers
const sendSystemErrorAlert = async (recipientEmails = []) => {
    if (!recipientEmails.length) return;

    const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff8f0;border-radius:12px;overflow:hidden;border:2px solid #fb923c">
      <div style="background:linear-gradient(90deg,#ea580c,#c2410c);padding:28px 32px">
        <h1 style="margin:0;color:#fff;font-size:20px;font-weight:800;letter-spacing:-.3px">⚠ AI Vision QC — SYSTEM ERROR</h1>
        <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:12px;letter-spacing:.12em;text-transform:uppercase">Automated System Notification</p>
      </div>
      <div style="padding:32px">
        <div style="text-align:center;margin-bottom:20px">
          <div style="width:60px;height:60px;background:#ffedd5;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:30px">🔧</div>
        </div>
        <h2 style="margin:0 0 12px;color:#9a3412;font-size:18px;text-align:center">System Error Alert</h2>
        <p style="color:#7c2d12;font-size:15px;line-height:1.7;margin:0 0 20px;text-align:center;font-weight:500">
          Please check your app, a system error has occurred!
        </p>
        <div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:16px 20px;font-size:13px;color:#9a3412;text-align:center">
          Open the application immediately and check the <strong>Error Logs</strong> section for details.
        </div>
      </div>
      <div style="padding:16px 32px;border-top:1px solid #fdba74;font-size:11px;color:#b0bec5;text-align:center">
        © ${new Date().getFullYear()} AI Vision QC — Smart Quality Control System
      </div>
    </div>`;

    const promises = recipientEmails.map(email =>
        sendEmail(email, "System Error Alert", html,
            "Please check your app, a system error has occurred!")
    );

    await Promise.allSettled(promises);
    console.log(`[Email] System error alert sent to ${recipientEmails.length} online worker(s)`);
};

module.exports = {
    sendEmail,
    sendPendingEmail,
    sendApprovedEmail,
    sendDangerAlert,
    sendSystemErrorAlert,
};
