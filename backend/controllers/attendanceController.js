const AttendanceLog = require('../models/AttendanceLog');
const User = require('../models/User');
const { emitSocketEvent } = require('../utils/socketEvents');

/* ─────────────────────────────────────────────────────────────────────
   LOCAL DATE HELPER
   toISOString() returns UTC which rolls back one day at midnight for
   UTC+1 and beyond.  We always store the LOCAL calendar date so that
   a session created at 00:30 Tunis time appears on the correct day.
───────────────────────────────────────────────────────────────────── */
function localDateStr(d = new Date()) {
  const y   = d.getFullYear();
  const mo  = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/* ─────────────────────────────────────────────────────────────────────
   CLOSE STALE OPEN SESSIONS
   Called on server startup to seal sessions left open by a crash,
   browser close, or server restart.  Sessions from a PREVIOUS day
   get their logoutTime set to end-of-that-day (23:59:59 local).
   Today's open sessions are left untouched (worker may still be active).
───────────────────────────────────────────────────────────────────── */
async function closeStaleOpenSessions() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const stale = await AttendanceLog.find({
    logoutTime: null,
    loginTime: { $lt: todayStart },
  });

  for (const s of stale) {
    // Seal at end of the day the session started
    const dayEnd = new Date(s.loginTime);
    dayEnd.setHours(23, 59, 59, 0);
    s.logoutTime = dayEnd;
    s.sessionDuration = Math.round((dayEnd - s.loginTime) / 60000);
    await s.save();
  }

  if (stale.length > 0) {
    console.log(`[attendance] Sealed ${stale.length} stale session(s) from previous days on startup`);
  }
  return stale.length;
}

/* =========================================================
   RECORD LOGIN SESSION
========================================================= */
async function recordLogin(userId, fullName, email, role, io) {
  const loginTime = new Date();
  const date = localDateStr(loginTime);   // LOCAL calendar date — not UTC

  // Close any still-open sessions for this user before opening a new one.
  // This handles: page refresh, multiple browser tabs, server restart recovery.
  const openSessions = await AttendanceLog.find({ userId, logoutTime: null });
  if (openSessions.length > 0) {
    for (const s of openSessions) {
      s.logoutTime = loginTime;
      s.sessionDuration = Math.round((loginTime - s.loginTime) / 60000);
      await s.save();
    }
    console.log(`[attendance] Closed ${openSessions.length} open session(s) for userId=${userId} (${fullName}) before new login`);
  }

  const log = await AttendanceLog.create({
    userId,
    fullName,
    username: fullName,
    email,
    role,
    loginTime,
    date,
  });

  console.log(`[attendance] Session started  userId=${userId}  name=${fullName}  date=${date}`);

  if (io) {
    emitSocketEvent(io, 'attendance_update', {
      action:    'login',
      userId:    userId.toString(),
      fullName,
      username:  fullName,
      email,
      role,
      loginTime: loginTime.toISOString(),
      date,
    });
  }

  return log;
}

/* =========================================================
   RECORD LOGOUT SESSION
========================================================= */
async function recordLogout(userId, io) {
  // Find the most-recent open session
  const log = await AttendanceLog.findOne({ userId, logoutTime: null }).sort({ loginTime: -1 });

  if (log) {
    log.logoutTime    = new Date();
    log.sessionDuration = Math.round((log.logoutTime - log.loginTime) / 60000);
    await log.save();

    console.log(`[attendance] Session closed  userId=${userId}  name=${log.fullName || log.email}  duration=${log.sessionDuration}min`);

    if (io) {
      emitSocketEvent(io, 'attendance_update', {
        action:          'logout',
        userId:          log.userId.toString(),
        fullName:        log.fullName || log.username,
        username:        log.fullName || log.username,
        email:           log.email,
        role:            log.role,
        logoutTime:      log.logoutTime.toISOString(),
        sessionDuration: log.sessionDuration,
      });
    }
  }

  return log;
}

/* =========================================================
   GET CURRENTLY CONNECTED WORKERS
========================================================= */
async function getConnectedWorkers(req, res) {
  try {
    const openSessions = await AttendanceLog.find({ logoutTime: null }).sort({ loginTime: -1 });

    const result = openSessions.map(s => ({
      userId:             s.userId.toString(),
      fullName:           s.fullName || s.username,
      username:           s.fullName || s.username,
      email:              s.email,
      role:               s.role,
      loginTime:          s.loginTime,
      sessionDurationMin: Math.round((Date.now() - new Date(s.loginTime)) / 60000),
      date:               s.date,
    }));

    res.json({ connected: result, count: result.length });
  } catch (err) {
    console.error('[attendance] getConnectedWorkers error:', err.message);
    res.status(500).json({ message: 'Error fetching connected workers', error: err.message });
  }
}

/* =========================================================
   GET ATTENDANCE HISTORY
   Supports:
     ?date=YYYY-MM-DD          → exact single day (uses LOCAL date field)
     ?range=week               → last 7 days
     ?range=month              → last 30 days
     ?dateFrom=...&dateTo=...  → custom range
     (no params)               → today (local)

   ALL approved users are always injected so no one is silently missing:
   workers WITH sessions → present/active, workers WITHOUT → absent.
========================================================= */
async function getAttendanceHistory(req, res) {
  try {
    const { date, userId, range, dateFrom, dateTo } = req.query;
    const filter = {};

    if (userId) filter.userId = userId;

    // Build the time-window filter
    if (date) {
      // Single-day exact match on the LOCAL date string stored in `date` field
      filter.date = date;
    } else if (dateFrom || dateTo) {
      filter.loginTime = {};
      if (dateFrom) filter.loginTime.$gte = new Date(dateFrom + 'T00:00:00');
      if (dateTo)   filter.loginTime.$lte = new Date(dateTo   + 'T23:59:59');
    } else if (range === 'week') {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      filter.loginTime = { $gte: weekAgo };
    } else if (range === 'month') {
      const monthAgo = new Date();
      monthAgo.setDate(monthAgo.getDate() - 30);
      filter.loginTime = { $gte: monthAgo };
    } else {
      // Default: today local
      filter.date = localDateStr();
    }

    const logs = await AttendanceLog.find(filter).sort({ loginTime: -1 }).limit(500);

    // Build per-worker summary from found sessions
    const workerMap = {};
    for (const log of logs) {
      const key = log.userId.toString();
      if (!workerMap[key]) {
        workerMap[key] = {
          userId:       key,
          fullName:     log.fullName || log.username,
          username:     log.fullName || log.username,
          email:        log.email,
          role:         log.role,
          totalMinutes: 0,
          sessions:     [],
          absent:       false,
        };
      }

      // Use stored duration or recalculate
      const dur =
        log.sessionDuration ||
        (log.logoutTime
          ? Math.round((new Date(log.logoutTime) - new Date(log.loginTime)) / 60000)
          : Math.round((Date.now() - new Date(log.loginTime)) / 60000));

      workerMap[key].totalMinutes += dur;
      workerMap[key].sessions.push({
        loginTime:       log.loginTime,
        logoutTime:      log.logoutTime,
        sessionDuration: dur,
        date:            log.date,
        isActive:        !log.logoutTime,
      });
    }

    // Inject ALL approved users that have no sessions in this window as absent.
    // This covers workers AND admins, and applies to every query type so the
    // summary table is never empty just because no one logged in.
    const allUsers = await User.find({ status: 'approved' }).select('-password');
    for (const w of allUsers) {
      const key = w._id.toString();
      if (!workerMap[key]) {
        const fullName = w.username || `${w.firstName || ''} ${w.lastName || ''}`.trim();
        workerMap[key] = {
          userId:       key,
          fullName,
          username:     fullName,
          email:        w.email,
          role:         w.role,
          totalMinutes: 0,
          sessions:     [],
          absent:       true,
        };
      }
    }

    const summary = Object.values(workerMap);
    const enrichedLogs = logs.map(l => ({
      ...l.toObject(),
      fullName: l.fullName || l.username,
    }));

    console.log(
      `[attendance] History query: filter=${JSON.stringify(filter)}  ` +
      `logs=${logs.length}  users=${summary.length}  ` +
      `absent=${summary.filter(s => s.absent).length}`
    );

    res.json({ logs: enrichedLogs, summary });
  } catch (err) {
    console.error('[attendance] History error:', err.message);
    res.status(500).json({ message: 'Error fetching attendance history', error: err.message });
  }
}

module.exports = {
  recordLogin,
  recordLogout,
  getConnectedWorkers,
  getAttendanceHistory,
  closeStaleOpenSessions,
};
