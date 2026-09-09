const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const pool = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares globales
app.use(cors());
app.use(express.json());

// ==========================================
// RUTA 1: GESTIÓN DE TURNOS (Con prevención de solapamiento)
// ==========================================
app.post('/api/v1/appointments', async (req, res) => {
    const { patient_id, doctor_id, start_time, end_time, reason } = req.body;

    if (new Date(start_time) >= new Date(end_time)) {
        return res.status(400).json({ error: 'La hora de inicio debe ser anterior a la hora de fin.' });
    }

    try {
        const checkQuery = `
            SELECT COUNT(*) FROM appointments 
            WHERE doctor_id = $1 
              AND status != 'cancelled'
              AND start_time < $3 
              AND end_time > $2;
        `;
        const checkResult = await pool.query(checkQuery, [doctor_id, start_time, end_time]);
        
        if (parseInt(checkResult.rows[0].count) > 0) {
            return res.status(409).json({ error: 'El médico ya posee un turno asignado en este rango horario.' });
        }

        const insertQuery = `
            INSERT INTO appointments (patient_id, doctor_id, start_time, end_time, reason, status)
            VALUES ($1, $2, $3, $4, $5, 'scheduled')
            RETURNING *;
        `;
        const newAppointment = await pool.query(insertQuery, [patient_id, doctor_id, start_time, end_time, reason]);

        return res.status(201).json({
            message: 'Turno creado con éxito',
            appointment: newAppointment.rows[0]
        });

    } catch (error) {
        if (error.code === '23P01') {
            return res.status(409).json({ error: 'Conflicto de horario: El turno se superpone con otro.' });
        }
        console.error('Error al crear el turno:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ==========================================
// RUTA 2: HISTORIA CLÍNICA (SOAP)
// ==========================================
app.post('/api/v1/medical-records', async (req, res) => {
    const { patient_id, doctor_id, appointment_id, subjective, objective, assessment, plan, vital_signs, sign_record } = req.body;

    if (!patient_id || !doctor_id || !subjective || !objective || !assessment || !plan) {
        return res.status(400).json({ error: 'Faltan campos obligatorios para completar la evolución SOAP.' });
    }

    try {
        const isLocked = sign_record ? true : false;
        const query = `
            INSERT INTO medical_records 
            (patient_id, doctor_id, appointment_id, subjective, objective, assessment, plan, vital_signs, is_locked)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *;
        `;
        const values = [patient_id, doctor_id, appointment_id || null, subjective, objective, assessment, plan, vital_signs ? JSON.stringify(vital_signs) : null, isLocked];
        const newRecord = await pool.query(query, values);

        if (appointment_id) {
            await pool.query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [appointment_id]);
        }

        return res.status(201).json({
            message: isLocked ? 'Evolución SOAP firmada y guardada con éxito.' : 'Borrador guardado correctamente.',
            medical_record: newRecord.rows[0]
        });
    } catch (error) {
        console.error('Error al guardar la historia clínica:', error);
        return res.status(500).json({ error: 'Error interno al procesar la historia clínica.' });
    }
});

// ==========================================
// RUTA 3: RECETAS ELECTRÓNICAS (Emisión y PDF)
// ==========================================
app.post('/api/v1/prescriptions', async (req, res) => {
    const { medical_record_id, patient_id, doctor_id, medication_details } = req.body;

    if (!patient_id || !doctor_id || !medication_details || medication_details.length === 0) {
        return res.status(400).json({ error: 'Faltan datos obligatorios para emitir la receta.' });
    }

    try {
        const securityHash = crypto.randomBytes(16).toString('hex');
        const query = `
            INSERT INTO prescriptions (medical_record_id, patient_id, doctor_id, medication_details, security_hash)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *;
        `;
        const newPrescription = await pool.query(query, [medical_record_id || null, patient_id, doctor_id, JSON.stringify(medication_details), securityHash]);

        return res.status(201).json({
            message: 'Receta electrónica emitida con éxito.',
            prescription: newPrescription.rows[0]
        });
    } catch (error) {
        console.error('Error al emitir la receta:', error);
        return res.status(500).json({ error: 'Error interno al procesar la receta.' });
    }
});

app.get('/api/v1/prescriptions/:id/pdf', async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT 
                p.id as prescription_id, p.medication_details, p.security_hash, p.created_at,
                pat.first_name as pat_first, pat.last_name as pat_last, pat.document_number as pat_doc,
                u.email as doc_email
            FROM prescriptions p
            JOIN patients pat ON p.patient_id = pat.id
            JOIN users u ON p.doctor_id = u.id
            WHERE p.id = $1 AND p.is_cancelled = FALSE;
        `;
        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Receta no encontrada o anulada.' });
        }

        const rx = result.rows[0];
        const medications = typeof rx.medication_details === 'string' ? JSON.parse(rx.medication_details) : rx.medication_details;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename=receta-${rx.prescription_id}.pdf`);

        const doc = new PDFDocument({ margin: 50 });
        doc.pipe(res);

        doc.fontSize(20).text('CENTRO MÉDICO / CLÍNICA', { align: 'center' });
        doc.fontSize(10).text('Receta Médica Electrónica - Válida Oficialmente', { align: 'center' });
        doc.moveDown(1.5);

        doc.fontSize(12).text(`Paciente: ${rx.pat_last}, ${rx.pat_first}`);
        doc.text(`DNI: ${rx.pat_doc}`);
        doc.text(`Fecha de emisión: ${new Date(rx.created_at).toLocaleDateString()}`);
        doc.moveDown(1);

        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown(1);

        doc.fontSize(16).text('Rp/', { underline: true });
        doc.moveDown(0.5);

        medications.forEach((med, index) => {
            doc.fontSize(12).text(`${index + 1}. ${med.drug_name}`);
            doc.fontSize(10).text(`     Presentación: ${med.presentation || 'N/A'}`);
            doc.text(`     Indicación: ${med.dosage} - Duración: ${med.duration}`);
            doc.moveDown(0.5);
        });

        doc.moveDown(3);
        doc.moveTo(50, doc.y).lineTo(250, doc.y).stroke();
        doc.fontSize(10).text('Firma y Sello del Profesional', 50, doc.y + 5);
        doc.fontSize(8).text(`Código de seguridad de verificación: ${rx.security_hash}`, 50, doc.y + 40, { align: 'left', oblique: true });

        doc.end();
    } catch (error) {
        console.error('Error al generar el PDF:', error);
        return res.status(500).json({ error: 'Error al generar el documento PDF.' });
    }
});

// Comprobación de estado del servidor
app.get('/', (req, res) => {
    res.send('API de la Clínica funcionando correctamente 🚀');
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
