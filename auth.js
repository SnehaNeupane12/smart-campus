const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
dotenv.config();

function authenticateRole(allowedRoles) {
    return (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: 'No token provided' });

        const token = authHeader.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Invalid token format' });

        jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
            if (err) return res.status(403).json({ message: 'Token invalid or expired' });

            if (!allowedRoles.includes(user.role)) {
                return res.status(403).json({ message: 'Access denied' });
            }

            req.user = user;
            next();
        });
    };
}

module.exports = authenticateRole;
