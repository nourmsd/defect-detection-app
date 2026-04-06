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

module.exports = {
    sendEmail,
    sendPendingEmail,
    sendApprovedEmail,
};
