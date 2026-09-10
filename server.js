const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de la base de datos PostgreSQL en Railway
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Configuración de Multer para la subida de archivos y fotos de pacientes
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Inicialización de Tablas en PostgreSQL al arrancar
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        dni VARCHAR(50) UNIQUE NOT NULL,
        phone VARCHAR(50),
        email VARCHAR(100),
        birth_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        patient_id INT REFERENCES patients(id) ON DELETE CASCADE,
        doctor_name VARCHAR(100) NOT NULL,
        appointment_date TIMESTAMP NOT NULL,
        status VARCHAR(50) DEFAULT 'Scheduled',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS folders (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        parent_id INT REFERENCES folders(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        folder_id INT REFERENCES folders(id) ON DELETE SET NULL,
        patient_id INT REFERENCES patients(id) ON DELETE SET NULL,
        file_path TEXT NOT NULL,
        file_type VARCHAR(50),
        size INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Base de datos y tablas verificadas/creadas con éxito.");
  } catch (err) {
    console.error("Error al inicializar la base de datos:", err);
  }
}
initDB();

// --- RUTAS DE PACIENTES ---
app.get('/api/v1/patients', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM patients ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/patients', async (req, res) => {
  const { first_name, last_name, dni, phone, email, birth_date } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO patients (first_name, last_name, dni, phone, email, birth_date) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [first_name, last_name, dni, phone, email, birth_date || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- RUTAS DE CITAS (APPOINTMENTS) ---
app.get('/api/v1/appointments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, p.first_name, p.last_name 
      FROM appointments a 
      JOIN patients p ON a.patient_id = p.id 
      ORDER BY a.appointment_date DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/appointments', async (req, res) => {
  const { patient_id, doctor_name, appointment_date, status, notes } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO appointments (patient_id, doctor_name, appointment_date, status, notes) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [patient_id, doctor_name, appointment_date, status || 'Scheduled', notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- RUTAS DE DOCUMENTOS Y CARPETAS (Gestión Estilo PC) ---
app.get('/api/v1/folders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM folders ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/folders', async (req, res) => {
  const { name, parent_id } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO folders (name, parent_id) VALUES ($1, $2) RETURNING *',
      [name, parent_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/v1/documents', async (req, res) => {
  const { folder_id, patient_id } = req.query;
  try {
    let query = 'SELECT * FROM documents WHERE 1=1';
    let params = [];
    if (folder_id) {
      params.push(folder_id);
      query += ` AND folder_id = $${params.length}`;
    }
    if (patient_id) {
      params.push(patient_id);
      query += ` AND patient_id = $${params.length}`;
    }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/documents', upload.single('file'), async (req, res) => {
  const { title, folder_id, patient_id } = req.body;
  const file = req.file;
  
  if (!file) {
    return res.status(400).json({ error: 'No se ha proporcionado ningún archivo.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO documents (title, folder_id, patient_id, file_path, file_type, size) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        title || file.originalname,
        folder_id || null,
        patient_id || null,
        `/uploads/${file.filename}`,
        file.mimetype,
        file.size
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Puerto de escucha dinámico asignado por Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor EMR corriendo exitosamente en el puerto ${PORT}`);
});
