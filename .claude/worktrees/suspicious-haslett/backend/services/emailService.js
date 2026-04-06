const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// Generic send function
const sendEmail = async (to, subject, text) => {
    try {
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to,
            subject,
            text,
        };

        await transporter.sendMail(mailOptions);
        console.log(" Email sent to:", to);
    } catch (error) {
        console.error(" Email error:", error);
    }
};

// Scenario 1: Registration
const sendPendingEmail = (email) => {
    return sendEmail(
        email,
        "Account Pending Approval",
        "We received your credentials. Please wait for admin approval."
    );
};

// Scenario 2: Approval
const sendApprovedEmail = (email) => {
    return sendEmail(
        email,
        "Account Approved",
        "Welcome! Your account has been verified. You can now log in."
    );
};

module.exports = {
    sendEmail,
    sendPendingEmail,
    sendApprovedEmail,
};
