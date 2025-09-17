const authenticateRole = require('./auth');
const db = require('./db');
const bcrypt = require('bcryptjs');
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const jwt = require('jsonwebtoken');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// ===== Helper: Add a notification =====
function addNotification(userId, message) {
    const sql = 'INSERT INTO notifications (user_id, message) VALUES (?, ?)';
    db.query(sql, [userId, message], (err) => {
        if (err) console.error('Error adding notification:', err.message);
    });
}
// ===== Helper: Award a badge =====
function awardBadge(studentId, badgeName, description) {
    const sql = 'INSERT INTO badges (student_id, badge_name, description) VALUES (?, ?, ?)';
    db.query(sql, [studentId, badgeName, description], (err) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') return; // Ignore duplicates
            console.error('Error awarding badge:', err.message);
        }
    });

    // 🔔 Notify the student
    addNotification(studentId, `🎉 You earned a badge: ${badgeName}`);
}

// Root route
app.get('/', (req, res) => {
    res.send('Smart Campus Backend Running');
});

// Test route to add a user
app.post('/test-add-user', async (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
        return res.status(400).json({ message: 'All fields required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const sql = 'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)';
    db.query(sql, [name, email, hashedPassword, role], (err, result) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json({ message: 'User added successfully', userId: result.insertId });
    });
});

// Step 1: Login route
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email & password required' });

    const sql = 'SELECT * FROM users WHERE email = ?';
    db.query(sql, [email], async (err, results) => {
        if (err) return res.status(500).json({ message: err.message });
        if (results.length === 0) return res.status(404).json({ message: 'User not found' });

        const user = results[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ message: 'Incorrect password' });

        // Create JWT token (valid for 7 days)
        const token = jwt.sign(
            { id: user.id, role: user.role, name: user.name },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ message: 'Login successful', token, role: user.role, name: user.name });
    });
});

// Admin-only route
app.get('/admin/dashboard', authenticateRole(['admin']), (req, res) => {
    res.send(`Welcome Admin ${req.user.name}`);
});

// Teacher-only route
app.get('/teacher/dashboard', authenticateRole(['teacher']), (req, res) => {
    res.send(`Welcome Teacher ${req.user.name}`);
});

// Student-only route
app.get('/student/dashboard', authenticateRole(['student']), (req, res) => {
    res.send(`Welcome Student ${req.user.name}`);
});

/* ====== Step 1: Teacher Marks Attendance ====== */
app.post('/teacher/attendance', authenticateRole(['teacher']), (req, res) => {
    const { student_id, date, status } = req.body;
    if (!student_id || !date || !status) {
        return res.status(400).json({ message: 'All fields required' });
    }

    const sql = 'INSERT INTO attendance (student_id, teacher_id, date, status) VALUES (?, ?, ?, ?)';
    db.query(sql, [student_id, req.user.id, date, status], (err, result) => {
        if (err) return res.status(500).json({ message: err.message });
    
        // 🔔 Notify the student
        addNotification(student_id, `Your attendance for ${date} was marked as ${status}.`);
    
        // 🏆 Check for badges
        // 1. Streak (7 consecutive presents)
        const streakSql = `
            SELECT COUNT(*) AS streak
            FROM (
                SELECT date
                FROM attendance
                WHERE student_id = ? AND status = 'present'
                ORDER BY date DESC
                LIMIT 7
            ) recent
        `;
        db.query(streakSql, [student_id], (err, streakResult) => {
            if (!err && streakResult[0].streak === 7) {
                awardBadge(student_id, "Perfect Streak", "Present 7 days in a row!");
            }
        });
    
        // 2. Overall percentage (90%+)
        const totalSql = 'SELECT COUNT(*) AS total FROM attendance WHERE student_id = ?';
        const presentSql = "SELECT COUNT(*) AS present FROM attendance WHERE student_id = ? AND status = 'present'";
        db.query(totalSql, [student_id], (err, totalRes) => {
            if (!err) {
                db.query(presentSql, [student_id], (err2, presentRes) => {
                    if (!err2) {
                        const percentage = (presentRes[0].present / totalRes[0].total) * 100;
                        if (percentage >= 90) {
                            awardBadge(student_id, "Consistency Star", "Maintained 90%+ attendance!");
                        }
                    }
                });
            }
        });
    
        res.json({ message: 'Attendance marked', attendanceId: result.insertId });
    });
    
});

/* ====== Step 2: Student Views Attendance ====== */
app.get('/student/attendance', authenticateRole(['student']), (req, res) => {
    const sql = `
        SELECT a.id, a.date, a.status, t.name AS teacher_name
        FROM attendance a
        JOIN users t ON a.teacher_id = t.id
        WHERE a.student_id = ?
        ORDER BY a.date DESC
    `;
    db.query(sql, [req.user.id], (err, results) => {
        if (err) return res.status(500).json({ message: err.message });
        res.json(results);
    });
});

/* ====== Student Attendance Percentage ====== */
app.get('/student/attendance/percentage', authenticateRole(['student']), (req, res) => {
    const studentId = req.user.id;

    const sqlTotal = 'SELECT COUNT(*) AS total FROM attendance WHERE student_id = ?';
    const sqlPresent = "SELECT COUNT(*) AS present FROM attendance WHERE student_id = ? AND status = 'present'";

    db.query(sqlTotal, [studentId], (err, totalResult) => {
        if (err) return res.status(500).json({ error: 'Database error' });

        db.query(sqlPresent, [studentId], (err, presentResult) => {
            if (err) return res.status(500).json({ error: 'Database error' });

            const total = totalResult[0].total;
            const present = presentResult[0].present;
            const percentage = total > 0 ? ((present / total) * 100).toFixed(2) : 0;

            res.json({ total_classes: total, present, percentage: `${percentage}%` });
        });
    });
});

/* ====== Admin Attendance Report (with optional month/year filter) ====== */
app.get('/admin/attendance/report', authenticateRole(['admin']), (req, res) => {
    const { month, year } = req.query;

    let filter = '';
    let params = [];

    if (month && year) {
        filter = 'AND MONTH(a.date) = ? AND YEAR(a.date) = ?';
        params = [month, year];
    }

    const sql = `
        SELECT u.id, u.name, 
               COUNT(a.id) AS total_classes,
               SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present_classes,
               ROUND((SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) / COUNT(a.id)) * 100, 2) AS percentage
        FROM users u
        LEFT JOIN attendance a ON u.id = a.student_id
        WHERE u.role = 'student' ${filter}
        GROUP BY u.id, u.name;
    `;

    db.query(sql, params, (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(results);
    });
});

/* ====== Teacher: Get All Students ====== */
app.get('/teacher/students', authenticateRole(['teacher']), (req, res) => {
    const sql = 'SELECT id, name, email FROM users WHERE role = "student"';
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(results);
    });
});

/* ====== Teacher: Upload Assignment ====== */
app.post('/teacher/assignments', authenticateRole(['teacher']), (req, res) => {
    const { title, description, due_date, file_path } = req.body;
    if (!title || !due_date) {
        return res.status(400).json({ message: 'Title and due_date are required' });
    }

    const sql = 'INSERT INTO assignments (teacher_id, title, description, due_date, file_path) VALUES (?, ?, ?, ?, ?)';
    db.query(sql, [req.user.id, title, description, due_date, file_path || null], (err, result) => {
        if (err) return res.status(500).json({ message: err.message });

        // 🔔 Notify all students
        const notifySql = 'SELECT id FROM users WHERE role = "student"';
        db.query(notifySql, (err, students) => {
            if (!err && students.length > 0) {
                students.forEach(s => addNotification(s.id, `New assignment posted: ${title}`));
            }
        });

        res.json({ message: 'Assignment created successfully', assignmentId: result.insertId });
    });
});

/* ====== Student: View All Assignments ====== */
app.get('/student/assignments', authenticateRole(['student']), (req, res) => {
    const sql = `
        SELECT a.id, a.title, a.description, a.due_date, a.file_path, a.created_at, t.name AS teacher_name
        FROM assignments a
        JOIN users t ON a.teacher_id = t.id
        ORDER BY a.created_at DESC
    `;

    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        res.json(results);
    });
});

/* ====== Student: Submit Assignment ====== */
app.post('/student/submissions', authenticateRole(['student']), (req, res) => {
    const { assignment_id, file_path } = req.body;

    if (!assignment_id || !file_path) {
        return res.status(400).json({ message: 'assignment_id and file_path are required' });
    }

    // First, check the assignment deadline
    const sqlDeadline = 'SELECT due_date, teacher_id FROM assignments WHERE id = ?';
    db.query(sqlDeadline, [assignment_id], (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        if (results.length === 0) return res.status(404).json({ message: 'Assignment not found' });

        const dueDate = new Date(results[0].due_date);
        const teacherId = results[0].teacher_id;
        const now = new Date();
        const status = now <= dueDate ? 'submitted' : 'late';

        const sql = 'INSERT INTO submissions (assignment_id, student_id, file_path, status) VALUES (?, ?, ?, ?)';
        db.query(sql, [assignment_id, req.user.id, file_path, status], (err, result) => {
            if (err) return res.status(500).json({ message: err.message });

            // 🔔 Notify the teacher
            addNotification(teacherId, `A student submitted Assignment #${assignment_id}.`);

            res.json({ message: 'Submission recorded', submissionId: result.insertId, status });
        });
    });
});

/* ====== Teacher: View Submissions for an Assignment ====== */
app.get('/teacher/submissions/:assignment_id', authenticateRole(['teacher']), (req, res) => {
    const { assignment_id } = req.params;

    const sql = `
        SELECT s.id, s.file_path, s.submitted_at, s.status,
               st.name AS student_name, st.email AS student_email
        FROM submissions s
        JOIN users st ON s.student_id = st.id
        WHERE s.assignment_id = ?
        ORDER BY s.submitted_at DESC
    `;

    db.query(sql, [assignment_id], (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        res.json(results);
    });
});

/* ====== Student: View Assignments with Submission Status ====== */
app.get('/student/assignments/status', authenticateRole(['student']), (req, res) => {
    const studentId = req.user.id;

    const sql = `
        SELECT a.id AS assignment_id, a.title, a.description, a.due_date, a.file_path,
               COALESCE(s.status, 'pending') AS submission_status,
               s.submitted_at, t.name AS teacher_name
        FROM assignments a
        JOIN users t ON a.teacher_id = t.id
        LEFT JOIN submissions s 
            ON a.id = s.assignment_id AND s.student_id = ?
        ORDER BY a.due_date ASC
    `;

    db.query(sql, [studentId], (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        res.json(results);
    });
});
/* ====== Student: Get Badges ====== */
app.get('/student/badges', authenticateRole(['student']), (req, res) => {
    const sql = 'SELECT badge_name, description, awarded_at FROM badges WHERE student_id = ? ORDER BY awarded_at DESC';
    db.query(sql, [req.user.id], (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        res.json(results);
    });
});

/* ====== Admin: Submissions Overview ====== */
app.get('/admin/submissions/overview', authenticateRole(['admin']), (req, res) => {
    const sql = `
        SELECT a.id AS assignment_id, a.title, a.due_date, t.name AS teacher_name,
               COUNT(s.id) AS total_submissions,
               SUM(CASE WHEN s.status = 'submitted' THEN 1 ELSE 0 END) AS on_time,
               SUM(CASE WHEN s.status = 'late' THEN 1 ELSE 0 END) AS late_submissions
        FROM assignments a
        JOIN users t ON a.teacher_id = t.id
        LEFT JOIN submissions s ON a.id = s.assignment_id
        GROUP BY a.id, a.title, a.due_date, t.name
        ORDER BY a.due_date DESC
    `;

    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        res.json(results);
    });
});

/* ====== Get Notifications ====== */
app.get('/notifications', authenticateRole(['admin','teacher','student']), (req, res) => {
    const sql = 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC';
    db.query(sql, [req.user.id], (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        res.json(results);
    });
});

/* ====== Mark Notification as Read ====== */
app.patch('/notifications/:id/read', authenticateRole(['admin','teacher','student']), (req, res) => {
    const { id } = req.params;

    const sql = 'UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?';
    db.query(sql, [id, req.user.id], (err, result) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Notification not found or not yours' });
        }
        res.json({ message: 'Notification marked as read' });
    });
});

/* ====== Student Dashboard Summary ====== */
app.get('/student/dashboard/summary', authenticateRole(['student']), (req, res) => {
    const studentId = req.user.id;

    const sqlAttendance = `
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) AS present
        FROM attendance WHERE student_id = ?;
    `;

    const sqlAssignments = `
        SELECT id, title, due_date 
        FROM assignments 
        WHERE due_date >= CURDATE()
        ORDER BY due_date ASC LIMIT 3;
    `;

    const sqlNotifications = `
        SELECT id, message, created_at, is_read
        FROM notifications 
        WHERE user_id = ? 
        ORDER BY created_at DESC LIMIT 5;
    `;

    db.query(sqlAttendance, [studentId], (err, attendanceResult) => {
        if (err) return res.status(500).json({ message: 'Database error' });

        db.query(sqlAssignments, (err, assignmentsResult) => {
            if (err) return res.status(500).json({ message: 'Database error' });

            db.query(sqlNotifications, [studentId], (err, notificationsResult) => {
                if (err) return res.status(500).json({ message: 'Database error' });

                const total = attendanceResult[0].total || 0;
                const present = attendanceResult[0].present || 0;
                const percentage = total > 0 ? ((present / total) * 100).toFixed(2) : 0;

                res.json({
                    attendance: `${percentage}%`,
                    upcoming_assignments: assignmentsResult,
                    notifications: notificationsResult
                });
            });
        });
    });
});

/* ====== Teacher Dashboard Summary ====== */
app.get('/teacher/dashboard/summary', authenticateRole(['teacher']), (req, res) => {
    const teacherId = req.user.id;

    const sqlStudents = `SELECT COUNT(*) AS total_students FROM users WHERE role = 'student'`;

    const sqlSubmissions = `
        SELECT s.id, s.assignment_id, s.submitted_at, s.status,
               st.name AS student_name, a.title AS assignment_title
        FROM submissions s
        JOIN users st ON s.student_id = st.id
        JOIN assignments a ON s.assignment_id = a.id
        WHERE a.teacher_id = ?
        ORDER BY s.submitted_at DESC LIMIT 5;
    `;

    const sqlAssignments = `
        SELECT id, title, due_date, created_at
        FROM assignments
        WHERE teacher_id = ?
        ORDER BY created_at DESC LIMIT 3;
    `;

    db.query(sqlStudents, (err, studentResult) => {
        if (err) return res.status(500).json({ message: 'Database error' });

        db.query(sqlSubmissions, [teacherId], (err, submissionsResult) => {
            if (err) return res.status(500).json({ message: 'Database error' });

            db.query(sqlAssignments, [teacherId], (err, assignmentsResult) => {
                if (err) return res.status(500).json({ message: 'Database error' });

                res.json({
                    total_students: studentResult[0].total_students,
                    recent_submissions: submissionsResult,
                    recent_assignments: assignmentsResult
                });
            });
        });
    });
});

/* ====== Admin Dashboard Summary ====== */
app.get('/admin/dashboard/summary', authenticateRole(['admin']), (req, res) => {
    const sqlUsers = `
        SELECT 
            SUM(CASE WHEN role = 'student' THEN 1 ELSE 0 END) AS total_students,
            SUM(CASE WHEN role = 'teacher' THEN 1 ELSE 0 END) AS total_teachers
        FROM users;
    `;

    const sqlAttendance = `
        SELECT 
            SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS total_present,
            SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS total_absent
        FROM attendance;
    `;

    const sqlSubmissions = `
        SELECT s.id, s.assignment_id, s.submitted_at, s.status,
               st.name AS student_name, a.title AS assignment_title, t.name AS teacher_name
        FROM submissions s
        JOIN users st ON s.student_id = st.id
        JOIN assignments a ON s.assignment_id = a.id
        JOIN users t ON a.teacher_id = t.id
        ORDER BY s.submitted_at DESC LIMIT 5;
    `;

    db.query(sqlUsers, (err, usersResult) => {
        if (err) return res.status(500).json({ message: 'Database error' });

        db.query(sqlAttendance, (err, attendanceResult) => {
            if (err) return res.status(500).json({ message: 'Database error' });

            db.query(sqlSubmissions, (err, submissionsResult) => {
                if (err) return res.status(500).json({ message: 'Database error' });

                res.json({
                    total_students: usersResult[0].total_students,
                    total_teachers: usersResult[0].total_teachers,
                    attendance_overview: {
                        present: attendanceResult[0].total_present || 0,
                        absent: attendanceResult[0].total_absent || 0
                    },
                    recent_submissions: submissionsResult
                });
            });
        });
    });
});

/* ====== Upload Note ====== */
app.post('/notes', authenticateRole(['student', 'teacher']), (req, res) => {
    const { title, description, file_path } = req.body;
    if (!title) {
        return res.status(400).json({ message: 'Title is required' });
    }

    const sql = 'INSERT INTO notes (user_id, title, description, file_path) VALUES (?, ?, ?, ?)';
    db.query(sql, [req.user.id, title, description || null, file_path || null], (err, result) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        res.json({ message: 'Note uploaded successfully', noteId: result.insertId });
    });
});


/* ====== Get All Notes ====== */
app.get('/notes', authenticateRole(['student', 'teacher', 'admin']), (req, res) => {
    const sql = `
        SELECT n.id, n.title, n.description, n.file_path, n.created_at, u.name AS uploaded_by
        FROM notes n
        JOIN users u ON n.user_id = u.id
        ORDER BY n.created_at DESC;
    `;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        res.json(results);
    });
});

/* ====== Create Poll (Teacher/Admin) ====== */
app.post('/polls', authenticateRole(['teacher', 'admin']), (req, res) => {
    const { question, options } = req.body;

    if (!question || !options || !Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ message: 'Question and at least 2 options are required' });
    }

    const pollSql = 'INSERT INTO polls (question, created_by) VALUES (?, ?)';
    db.query(pollSql, [question, req.user.id], (err, result) => {
        if (err) return res.status(500).json({ message: 'Database error' });

        const pollId = result.insertId;

        const optionSql = 'INSERT INTO poll_options (poll_id, option_text) VALUES ?';
        const values = options.map(opt => [pollId, opt]);

        db.query(optionSql, [values], (err2) => {
            if (err2) return res.status(500).json({ message: 'Database error adding options' });
            res.json({ message: 'Poll created successfully', pollId });
        });
    });
});

/* ====== Get All Polls ====== */
app.get('/polls', authenticateRole(['student','teacher','admin']), (req, res) => {
    const sql = `
        SELECT p.id AS poll_id, p.question, p.created_at, u.name AS created_by,
               o.id AS option_id, o.option_text
        FROM polls p
        JOIN users u ON p.created_by = u.id
        JOIN poll_options o ON p.id = o.poll_id
        ORDER BY p.created_at DESC
    `;

    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error' });

        const polls = {};
        results.forEach(r => {
            if (!polls[r.poll_id]) {
                polls[r.poll_id] = {
                    poll_id: r.poll_id,
                    question: r.question,
                    created_at: r.created_at,
                    created_by: r.created_by,
                    options: []
                };
            }
            polls[r.poll_id].options.push({ option_id: r.option_id, text: r.option_text });
        });

        res.json(Object.values(polls));
    });
});
/* ====== Vote on a Poll (Student/Teacher/Admin) ====== */
app.post('/polls/:id/vote', authenticateRole(['student','teacher','admin']), (req, res) => {
    const { id } = req.params;
    const { option_id } = req.body;

    if (!option_id) {
        return res.status(400).json({ message: 'option_id is required' });
    }

    const sql = 'INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)';
    db.query(sql, [id, option_id, req.user.id], (err, result) => {
        if (err) {
            // Prevent duplicate votes from breaking everything
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ message: 'You have already voted on this poll' });
            }
            return res.status(500).json({ message: 'Database error' });
        }
        res.json({ message: 'Vote recorded successfully' });
    });
});

/* ====== Get Poll Results ====== */
app.get('/polls/:id/results', authenticateRole(['student','teacher','admin']), (req, res) => {
    const { id } = req.params;

    const sql = `
        SELECT o.id AS option_id, o.option_text,
               COUNT(v.id) AS votes
        FROM poll_options o
        LEFT JOIN poll_votes v ON o.id = v.option_id
        WHERE o.poll_id = ?
        GROUP BY o.id, o.option_text
        ORDER BY o.id;
    `;

    db.query(sql, [id], (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        res.json(results);
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
