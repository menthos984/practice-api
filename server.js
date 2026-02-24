const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const session = require('express-session');
const { sso } = require('node-expose-sspi');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
    origin: 'http://localhost:3000',
    credentials: true
}));
app.use(express.json());

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Session setup (for caching)
app.use(session({
    name: 'sso-session',
    secret: process.env.SESSION_SECRET || 'change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: false, // true if HTTPS
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// Session setup (for caching)
app.use(session({
    name: 'sso-session',
    secret: process.env.SESSION_SECRET || 'change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: false, // true if HTTPS
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// 1. UNPROTECTED ROUTE - Triggers SSO handshake
app.post('/api/auth/sso-login', sso.auth({ useSession: true }), (req, res) => {
    // If we get here, authentication succeeded
    // Store user in session
    req.session.user = req.sso.user;
    req.session.authenticated = true;

    res.json({
        success: true,
        user: {
            name: req.sso.user.displayName,
            username: req.sso.user.name,
            domain: req.sso.user.domain
        }
    });
});

// 2. Middleware to protect API routes
function requireAuth(req, res, next) {
    if (!req.session.authenticated) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
}

// 3. Check auth status (for React to verify)
app.get('/api/auth/status', (req, res) => {
    if (req.session.authenticated) {
        res.json({
            authenticated: true,
            user: {
                name: req.session.user.displayName,
                username: req.session.user.name
            }
        });
    } else {
        res.json({ authenticated: false });
    }
});

// 4. Logout
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Security headers
app.use(helmet());

// Database configuration
const dbConfig = {
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: {
        encrypt: false,
        trustServerCertificate: true,
        connectTimeout: 30000
    }
};

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Get all employees with department name
app.get('/api/employees', requireAuth, async (req, res) => {
    try {
        await sql.connect(dbConfig);
        const result = await sql.query`
      SELECT e.*, d.dept_name 
      FROM Employees e
      LEFT JOIN Departments d ON e.department_id = d.dept_id
    `;
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        sql.close();
    }
});

// Get single employee
app.get('/api/employees/:id', requireAuth, async (req, res) => {
    try {
        await sql.connect(dbConfig);
        const result = await sql.query`
      SELECT e.*, d.dept_name 
      FROM Employees e
      LEFT JOIN Departments d ON e.department_id = d.dept_id
      WHERE e.id = ${req.params.id}
    `;
        res.json(result.recordset[0] || { message: 'Employee not found' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        sql.close();
    }
});

// Get all departments
app.get('/api/departments', requireAuth, async (req, res) => {
    try {
        await sql.connect(dbConfig);
        const result = await sql.query`SELECT * FROM Departments`;
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        sql.close();
    }
});

// Create employee
app.post('/api/employees', requireAuth, async (req, res) => {

    const { first_name, last_name, age, birthday, department_id } = req.body;

    if (!first_name || !last_name || !age || !birthday || !department_id) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    if (isNaN(age) || age < 0 || age > 120) {
        return res.status(400).json({ error: 'Invalid age' });
    }

    try {
        const { first_name, last_name, age, birthday, department_id } = req.body;
        await sql.connect(dbConfig);

        // Insert and return with department name
        const result = await sql.query`
      INSERT INTO Employees (first_name, last_name, age, birthday, department_id)
      OUTPUT INSERTED.*
      VALUES (${first_name}, ${last_name}, ${age}, ${birthday}, ${department_id})
    `;

        const newEmployee = result.recordset[0];

        // Get department name separately
        const deptResult = await sql.query`
      SELECT dept_name FROM Departments WHERE dept_id = ${department_id}
    `;

        // Combine the data
        const employeeWithDept = {
            ...newEmployee,
            dept_name: deptResult.recordset[0]?.dept_name || null
        };

        res.status(201).json(employeeWithDept);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        sql.close();
    }
});

// Update employee
app.put('/api/employees/:id', requireAuth, async (req, res) => {
    try {
        const { first_name, last_name, age, birthday, department_id } = req.body;
        const id = req.params.id;

        await sql.connect(dbConfig);

        await sql.query`
      UPDATE Employees 
      SET first_name = ${first_name},
          last_name = ${last_name},
          age = ${age},
          birthday = ${birthday},
          department_id = ${department_id}
      WHERE id = ${id}
    `;

        // Fetch updated employee with department name
        const result = await sql.query`
      SELECT e.*, d.dept_name 
      FROM Employees e
      LEFT JOIN Departments d ON e.department_id = d.dept_id
      WHERE e.id = ${id}
    `;

        res.json(result.recordset[0]);

    } catch (err) {
        console.error('PUT error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        sql.close();
    }
});

// Delete employee
app.delete('/api/employees/:id', requireAuth, async (req, res) => {
    try {
        await sql.connect(dbConfig);
        await sql.query`DELETE FROM Employees WHERE id = ${req.params.id}`;
        res.status(204).send(); // No content
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        sql.close();
    }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});