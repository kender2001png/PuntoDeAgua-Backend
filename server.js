require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api'); // Importar la librería de Telegram

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.use(cors({
    origin: 'https://puntodeagua-inicio.onrender.com',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Configuración del pool de la base de datos
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: {
        rejectUnauthorized: false
    },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 20
});

// Eventos del pool para depuración
pool.on('connect', client => {
  console.log('DB: Cliente conectado al pool.');
});

pool.on('acquire', client => {
  console.log('DB: Cliente adquirido del pool (listo para usar).');
});

pool.on('remove', client => {
  console.log('DB: Cliente removido del pool.');
});

pool.on('error', (err, client) => {
  console.error('*** ERROR DEL POOL DE CONEXIONES DE LA DB (unhandled error):', err.message, err.stack);
});


// --- CONFIGURACIÓN DE TELEGRAM ---
// Es crucial que estas variables de entorno estén definidas en tu archivo .env
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Puede ser un ID de chat o de grupo

// Verificar que los tokens estén definidos
if (!TELEGRAM_BOT_TOKEN || !CHAT_ID) {
    console.warn('ADVERTENCIA: Las variables de entorno TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no están definidas. Los mensajes de Telegram no se enviarán.');
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false }); // No necesitamos polling para solo enviar mensajes

// Función para enviar mensajes a Telegram
async function enviarMensajeATelegram(mensaje) {
    if (!TELEGRAM_BOT_TOKEN || !CHAT_ID) {
        console.error('No se puede enviar mensaje a Telegram: Token o Chat ID no configurados.');
        return;
    }
    try {
        await bot.sendMessage(CHAT_ID, mensaje, { parse_mode: 'HTML' });
        console.log('Mensaje enviado a Telegram con éxito.');
    } catch (error) {
        console.error('Error al enviar mensaje a Telegram:', error.message);
        // Puedes añadir más lógica de manejo de errores aquí, como reintentos o notificaciones.
    }
}
// --- FIN CONFIGURACIÓN DE TELEGRAM ---


// 1. Ruta de prueba (ya la probamos y funciona)
app.get('/', async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT NOW()');
        client.release();
        res.status(200).json({
            message: 'Servidor backend y conexión a DB de Neon exitosa!',
            currentTime: result.rows[0].now
        });
    } catch (err) {
        console.error('*** ERROR CRÍTICO en / : Fallo en la conexión a la base de datos o al ejecutar consulta de prueba:', err.message);
        res.status(500).json({ error: 'Error interno del servidor al probar la conexión a la DB.', details: err.message });
    }
});

// 2. Ruta para el REGISTRO de usuarios
app.post('/register', async (req, res) => {
    console.log('--- Petición de REGISTRO recibida ---');
    console.log('Cuerpo de la petición (req.body):', req.body);

    const { email, password, nombre, apellido, telefono, direccion } = req.body;

    if (!email || !password || !nombre || !apellido || !direccion) {
        console.log('ERROR: Campos obligatorios de registro incompletos.');
        return res.status(400).json({ message: 'Por favor, completa todos los campos obligatorios.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        console.log('DEBUG: Contraseña hasheada. Intentando insertar usuario en DB...');

        const client = await pool.connect();
        const result = await client.query(
            `INSERT INTO public.usuarios (email, password_hash, nombre, apellido, telefono, direccion, estado)
             VALUES ($1, $2, $3, $4, $5, $6, 'activo')
             RETURNING id, email, nombre, rol, estado;`, // Aseguramos que 'rol' y 'estado' también se devuelven
            [email, hashedPassword, nombre, apellido, telefono, direccion]
        );
        client.release();
        console.log('DEBUG: Usuario insertado exitosamente en DB.');

        res.status(201).json({
            message: 'Usuario registrado exitosamente',
            user: result.rows[0]
        });

    } catch (err) {
        if (err.code === '23505') {
            console.error('ERROR de registro (email duplicado):', email);
            return res.status(409).json({ message: 'El correo electrónico ya está registrado.' });
        }
        console.error('ERROR CRÍTICO al registrar usuario:', err);
        res.status(500).json({ error: 'Error interno del servidor al registrar usuario.', details: err.message });
    }
    console.log('--- Fin de petición de REGISTRO ---');
});

// 3. Ruta para el LOGIN de usuarios
app.post('/login', async (req, res) => {
    console.log('--- Petición de LOGIN recibida ---');
    console.log('Cuerpo de la petición (req.body):', req.body);

    const { email, password } = req.body;

    if (!email || !password) {
        console.log('ERROR: Email o contraseña de login vacíos.');
        return res.status(400).json({ message: 'Email y contraseña son requeridos.' });
    }

    try {
        console.log('DEBUG: Intentando buscar usuario para login:', email);
        const client = await pool.connect();
        const result = await client.query(
            'SELECT id, email, password_hash, nombre, apellido, telefono, direccion, rol, estado FROM public.usuarios WHERE email = $1', // Añadimos 'estado'
            [email]
        );
        client.release();

        const user = result.rows[0];

        if (!user) {
            console.log('DEBUG: Usuario no encontrado para login:', email);
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        // NUEVA LÓGICA: Verificar el estado del usuario
        if (user.estado === 'suspendido') {
            console.log('DEBUG: Intento de login de usuario suspendido:', email);
            return res.status(403).json({ message: 'Su cuenta ha sido suspendida. Por favor, contacte al administrador.' });
        }

        console.log('DEBUG: Usuario encontrado. Comparando contraseña...');
        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (!isMatch) {
            console.log('DEBUG: Contraseña incorrecta para usuario:', email);
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        res.status(200).json({
            message: 'Inicio de sesión exitoso',
            user: {
                id: user.id,
                email: user.email,
                nombre: user.nombre,
                apellido: user.apellido, // Incluimos apellido
                telefono: user.telefono, // Incluimos telefono
                direccion: user.direccion, // Incluimos direccion
                rol: user.rol,
                estado: user.estado // Incluimos el estado
            }
        });
        console.log('DEBUG: Login exitoso para usuario:', email);

    } catch (err) {
        console.error('ERROR CRÍTICO al iniciar sesión:', err);
        res.status(500).json({ error: 'Error interno del servidor al iniciar sesión.', details: err.message });
    }
    console.log('--- Fin de petición de LOGIN ---');
});

// NUEVO: 4. Ruta para OBTENER información de un usuario por ID
app.get('/user/:id', async (req, res) => {
    const { id } = req.params;
    console.log(`--- Petición para obtener usuario recibida para ID: ${id} ---`);

    try {
        const client = await pool.connect();
        const result = await client.query(
            'SELECT id, email, nombre, apellido, telefono, direccion, rol, estado FROM public.usuarios WHERE id = $1', // Añadimos 'estado'
            [id]
        );
        client.release();

        const user = result.rows[0];

        if (!user) {
            console.log('DEBUG: Usuario no encontrado para ID:', id);
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        res.status(200).json({ user });
        console.log('DEBUG: Usuario encontrado y enviado:', user.email);

    } catch (err) {
        console.error('ERROR CRÍTICO al obtener usuario por ID:', err);
        res.status(500).json({ error: 'Error interno del servidor al obtener usuario.', details: err.message });
    }
    console.log('--- Fin de petición de obtener usuario ---');
});

// NUEVO: 5. Ruta para ACTUALIZAR información de un usuario por ID
app.put('/user/:id', async (req, res) => {
    const { id } = req.params;
    const { telefono, direccion } = req.body; // Solo permitimos actualizar telefono y direccion
    console.log(`--- Petición para actualizar usuario recibida para ID: ${id} ---`);
    console.log('Cuerpo de la petición (req.body):', req.body);

    if (!telefono && !direccion) {
        return res.status(400).json({ message: 'Se requiere al menos un campo (telefono o direccion) para actualizar.' });
    }

    try {
        const client = await pool.connect();
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;

        if (telefono !== undefined) { // Permite actualizar a vacío si se envía explícitamente
            updateFields.push(`telefono = $${paramIndex++}`);
            updateValues.push(telefono);
        }
        if (direccion !== undefined) { // Permite actualizar a vacío si se envía explícitamente
            updateFields.push(`direccion = $${paramIndex++}`);
            updateValues.push(direccion);
        }
        
        // También actualizamos la columna updated_at
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);


        const queryText = `UPDATE public.usuarios SET ${updateFields.join(', ')} WHERE id = $${paramIndex} RETURNING id, email, nombre, apellido, telefono, direccion, rol, estado;`; // Añadimos 'estado'
        updateValues.push(id);

        const result = await client.query(queryText, updateValues);
        client.release();

        const updatedUser = result.rows[0];

        if (!updatedUser) {
            console.log('DEBUG: Usuario no encontrado para actualización para ID:', id);
            return res.status(404).json({ message: 'Usuario no encontrado para actualizar.' });
        }

        res.status(200).json({
            message: 'Usuario actualizado exitosamente',
            user: updatedUser
        });
        console.log('DEBUG: Usuario actualizado y enviado:', updatedUser.email);

    } catch (err) {
        console.error('ERROR CRÍTICO al actualizar usuario:', err);
        res.status(500).json({ error: 'Error interno del servidor al actualizar usuario.', details: err.message });
    }
    console.log('--- Fin de petición de actualizar usuario ---');
});

// 6. Ruta para registrar un nuevo pedido
app.post('/api/pedidos', async (req, res) => {
    console.log('--- Petición de REGISTRO DE PEDIDO recibida ---');
    console.log('Cuerpo de la petición (req.body):', req.body);

    const { userId, nombreCliente, telefonoCliente, direccionEnvio, botellones, metodoPago, bancoSeleccionado, referencia, costoTotal } = req.body;

    // Validaciones básicas de los campos del pedido
    if (!userId || !nombreCliente || !direccionEnvio || !botellones || !metodoPago || costoTotal === undefined) {
        console.log('ERROR: Faltan datos obligatorios para el registro del pedido.');
        return res.status(400).json({ message: 'Por favor, completa todos los campos obligatorios del pedido.' });
    }

    try {
        const client = await pool.connect();
        const result = await client.query(
            `INSERT INTO public.pedidos (user_id, nombre_cliente, telefono_cliente, direccion_envio, botellones_18l, botellones_12l, botellones_5l, metodo_pago, banco_seleccionado, referencia, costo_total)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING *`, // Retorna el pedido completo insertado
            [
                userId,
                nombreCliente,
                telefonoCliente || null,
                direccionEnvio,
                botellones['18L'] || 0,
                botellones['12L'] || 0,
                botellones['5L'] || 0,
                metodoPago,
                bancoSeleccionado || null,
                referencia || null,
                costoTotal
            ]
        );
        client.release();
        console.log('DEBUG: Pedido insertado exitosamente en DB.');

        const nuevoPedido = result.rows[0];

        // --- Lógica para enviar el mensaje a Telegram ---
        // Aquí construyes el mensaje de Telegram con los datos del pedido
        const formatter = new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
            useGrouping: true
        });

        // Normalizar el numero de telefono para Telegram y WhatsApp:
        // 1. Eliminar todos los caracteres que no sean digitos.
        // 2. Si empieza con '0', eliminar ese '0' inicial.
        // 3. Asegurar que empiece con '58'. Si no, anadirlo.
        let telefonoNormalizado = telefonoCliente.replace(/[^0-9]/g, ''); 
        if (telefonoNormalizado.startsWith('0')) {
            telefonoNormalizado = telefonoNormalizado.substring(1);
        }
        if (!telefonoNormalizado.startsWith('58')) {
            telefonoNormalizado = '58' + telefonoNormalizado;
        }
        const telefonoParaLink = `+${telefonoNormalizado}`; // Para mostrar con el '+' y usar en el link

        // Codificar la direccion para la URL de Google Maps
        const direccionCodificada = encodeURIComponent(direccionEnvio);
        const googleMapsLink = `https://www.google.com/maps/search/?api=1&query=${direccionCodificada}`;


        let mensajeTelegram = `<b>💧 Nuevo Pedido de Botellones 💧</b>\n\n`;
        mensajeTelegram += `<b>👤 Cliente:</b> ${nombreCliente}\n`;
        mensajeTelegram += `<b>📞 Teléfono:</b> <a href="https://wa.me/${telefonoNormalizado}">${telefonoParaLink}</a>\n`; // Link de WhatsApp usando el numero normalizado
        // MODIFICACIÓN CRÍTICA AQUÍ: Usar direccionEnvio (sin codificar) para el texto visible.
        mensajeTelegram += `<b>📍 Dirección:</b> <a href="${googleMapsLink}">${direccionEnvio}</a>\n`; // Link de Google Maps, muestra la dirección legible.
        mensajeTelegram += `<b>📅 Fecha de Pedido:</b> ${new Date(nuevoPedido.fecha_pedido).toLocaleString()}\n\n`; // Usar fecha_pedido de la DB
        
        mensajeTelegram += `<b>📦 Detalle del Pedido:</b>\n`;
        if (botellones["18L"] > 0) mensajeTelegram += `  - ${botellones["18L"]} botellones de 18Lts\n`;
        if (botellones["12L"] > 0) mensajeTelegram += `  - ${botellones["12L"]} botellones de 12Lts\n`;
        if (botellones["5L"] > 0) mensajeTelegram += `  - ${botellones["5L"]} botellones de 5Lts\n`;
        mensajeTelegram += `\n<i>📝 Los precios incluyen recarga y servicio a domicilio.</i>\n`;
        mensajeTelegram += `<b>💲 Total a Pagar:</b> ${formatter.format(costoTotal)}\n\n`;

        mensajeTelegram += `<b>💳 Método de Pago:</b> ${metodoPago}\n`;
        if (bancoSeleccionado) {
            mensajeTelegram += `<b>🏦 Banco:</b> ${bancoSeleccionado}\n`;
        }
        if (referencia) {
            mensajeTelegram += `<b>🔢 Referencia:</b> ${referencia}\n`;
        }
        
        // Llama a la función para enviar el mensaje a Telegram
        await enviarMensajeATelegram(mensajeTelegram);

        res.status(201).json({
            message: 'Pedido registrado y notificado a Telegram exitosamente',
            pedido: nuevoPedido
        });

    } catch (err) {
        console.error('ERROR CRÍTICO al registrar pedido o enviar a Telegram:', err);
        res.status(500).json({ error: 'Error interno del servidor al registrar el pedido.', details: err.message });
    }
    console.log('--- Fin de petición de REGISTRO DE PEDIDO ---');
});


// NUEVO: 7. Ruta para obtener el historial de pedidos de un usuario
app.get('/api/historial/:userId', async (req, res) => {
    const { userId } = req.params;
    console.log(`--- Petición para obtener historial de pedidos para userId: ${userId} recibida en el servidor ---`);

    if (!userId || userId === 'undefined' || userId === 'null') { // Manejo explícito de userId inválido
        console.log('ERROR: userId es inválido o no proporcionado para obtener el historial.');
        return res.status(400).json({ message: 'El ID de usuario es requerido y debe ser válido.' });
    }

    let client; // Declarar client fuera del try para asegurar que esté accesible en finally
    try {
        console.log(`DEBUG: Intentando conectar a la DB para userId: ${userId}`);
        client = await pool.connect();
        console.log(`DEBUG: Conexión a DB exitosa para userId: ${userId}. Ejecutando consulta...`);
        const result = await client.query(
            `SELECT 
                id, 
                user_id, 
                nombre_cliente, 
                telefono_cliente, 
                direccion_envio, 
                fecha_pedido, 
                botellones_18l, 
                botellones_12l, 
                botellones_5l, 
                metodo_pago, 
                banco_seleccionado, 
                referencia, 
                costo_total, 
                estado_pedido
             FROM public.pedidos 
             WHERE user_id = $1
             ORDER BY fecha_pedido DESC;`, // Ordenar por fecha_pedido descendente (más reciente primero)
            [userId]
        );
        console.log(`DEBUG: Consulta ejecutada para userId: ${userId}. Filas encontradas: ${result.rows.length}`);
        
        const historialPedidos = result.rows;

        res.status(200).json({
            message: 'Historial de pedidos obtenido exitosamente',
            historial: historialPedidos
        });
        console.log(`DEBUG: Historial de pedidos enviado exitosamente para userId: ${userId}`);

    } catch (err) {
        console.error(`ERROR CRÍTICO al obtener historial de pedidos para userId ${userId}:`, err.message);
        console.error('Detalles del error:', err.stack); // Mostrar stack trace para más detalles
        res.status(500).json({ error: 'Error interno del servidor al obtener el historial de pedidos.', details: err.message });
    } finally {
        if (client) {
            client.release();
            console.log(`DEBUG: Cliente de DB liberado para userId: ${userId}`);
        }
    }
    console.log('--- Fin de petición de historial de pedidos ---');
});

// 8. Ruta para obtener todos los pedidos pendientes para el distribuidor
app.get('/api/distribuidor/pedidos/pendientes', async (req, res) => {
    console.log('--- Petición para obtener pedidos PENDIENTES para distribuidor recibida ---');

    try {
        const client = await pool.connect();
        const result = await client.query(
            `SELECT 
                id, 
                user_id, 
                nombre_cliente, 
                telefono_cliente, 
                direccion_envio, 
                fecha_pedido, 
                botellones_18l, 
                botellones_12l, 
                botellones_5l, 
                metodo_pago, 
                banco_seleccionado, 
                referencia, 
                costo_total, 
                estado_pedido
             FROM public.pedidos 
             WHERE estado_pedido = 'pendiente'
             ORDER BY fecha_pedido DESC;`
        );
        client.release();

        const pedidosPendientes = result.rows;
        console.log(`DEBUG: Se encontraron ${pedidosPendientes.length} pedidos pendientes.`);

        res.status(200).json({
            message: 'Pedidos pendientes obtenidos exitosamente',
            pedidos: pedidosPendientes
        });

    } catch (err) {
        console.error('ERROR CRÍTICO al obtener pedidos pendientes para distribuidor:', err);
        res.status(500).json({ error: 'Error interno del servidor al obtener pedidos pendientes.', details: err.message });
    }
    console.log('--- Fin de petición de pedidos PENDIENTES para distribuidor ---');
});

// 9. Ruta para actualizar el estado de un pedido
app.put('/api/pedidos/:id/estado', async (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    console.log(`--- Petición para actualizar estado de pedido ${id} a ${estado} recibida ---`);

    if (!estado) {
        return res.status(400).json({ message: 'El estado del pedido es requerido.' });
    }

    // Lista de estados válidos
    const estadosValidos = ['pendiente', 'aceptado', 'en proceso', 'en camino', 'entregado', 'rechazado'];
    if (!estadosValidos.includes(estado.toLowerCase())) {
        return res.status(400).json({ message: 'Estado de pedido inválido.' });
    }

    try {
        const client = await pool.connect();
        const result = await client.query(
            `UPDATE public.pedidos 
             SET estado_pedido = $1, fecha_actualizacion = CURRENT_TIMESTAMP 
             WHERE id = $2 
             RETURNING *;`,
            [estado.toLowerCase(), id]
        );
        client.release();

        const updatedPedido = result.rows[0];

        if (!updatedPedido) {
            console.log('DEBUG: Pedido no encontrado para actualización de estado para ID:', id);
            return res.status(404).json({ message: 'Pedido no encontrado para actualizar su estado.' });
        }

        res.status(200).json({
            message: 'Estado del pedido actualizado exitosamente',
            pedido: updatedPedido
        });
        console.log('DEBUG: Estado del pedido actualizado y enviado:', updatedPedido.id, updatedPedido.estado_pedido);

    } catch (err) {
        console.error('ERROR CRÍTICO al actualizar estado del pedido:', err);
        res.status(500).json({ error: 'Error interno del servidor al actualizar el estado del pedido.', details: err.message });
    }
    console.log('--- Fin de petición de actualizar estado del pedido ---');
});


// 10. Ruta para obtener los pedidos ACEPTADOS (nuevo enfoque para el historial del distribuidor)
app.get('/api/distribuidor/pedidos/aceptados', async (req, res) => {
    console.log('--- Petición para obtener pedidos ACEPTADOS para distribuidor recibida ---');

    try {
        const client = await pool.connect();
        const result = await client.query(
            `SELECT 
                id, 
                user_id, 
                nombre_cliente, 
                telefono_cliente, 
                direccion_envio, 
                fecha_pedido, 
                botellones_18l, 
                botellones_12l, 
                botellones_5l, 
                metodo_pago, 
                banco_seleccionado, 
                referencia, 
                costo_total, 
                estado_pedido
             FROM public.pedidos 
             WHERE estado_pedido IN ('aceptado', 'en proceso', 'en camino') -- Filtrado para mostrar aceptados, en proceso y en camino
             ORDER BY fecha_pedido DESC;`
        );
        client.release();

        const pedidosAceptados = result.rows;
        console.log(`DEBUG: Se encontraron ${pedidosAceptados.length} pedidos aceptados.`);

        res.status(200).json({
            message: 'Pedidos aceptados obtenidos exitosamente',
            pedidos: pedidosAceptados
        });

    } catch (err) {
        console.error('ERROR CRÍTICO al obtener pedidos aceptados para distribuidor:', err);
        res.status(500).json({ error: 'Error interno del servidor al obtener pedidos aceptados.', details: err.message });
    }
    console.log('--- Fin de petición de pedidos ACEPTADOS para distribuidor ---');
});

// 11. Ruta para obtener los pedidos ENTREGADOS
app.get('/api/distribuidor/pedidos/entregados', async (req, res) => {
    console.log('--- Petición para obtener pedidos ENTREGADOS para distribuidor recibida ---');

    try {
        const client = await pool.connect();
        const result = await client.query(
            `SELECT 
                id, 
                user_id, 
                nombre_cliente, 
                telefono_cliente, 
                direccion_envio, 
                fecha_pedido, 
                botellones_18l, 
                botellones_12l, 
                botellones_5l, 
                metodo_pago, 
                banco_seleccionado, 
                referencia, 
                costo_total, 
                estado_pedido
             FROM public.pedidos 
             WHERE estado_pedido = 'entregado'
             ORDER BY fecha_pedido DESC;`
        );
        client.release();

        const pedidosEntregados = result.rows;
        console.log(`DEBUG: Se encontraron ${pedidosEntregados.length} pedidos entregados.`);

        res.status(200).json({
            message: 'Pedidos entregados obtenidos exitosamente',
            pedidos: pedidosEntregados
        });

    } catch (err) {
        console.error('ERROR CRÍTICO al obtener pedidos entregados para distribuidor:', err);
        res.status(500).json({ error: 'Error interno del servidor al obtener pedidos entregados.', details: err.message });
    }
    console.log('--- Fin de petición de pedidos ENTREGADOS para distribuidor ---');
});

// --- NUEVAS RUTAS PARA LA GESTIÓN DE USUARIOS (CRUD) ---

// 12. Ruta para OBTENER TODOS los usuarios (con filtro opcional por rol)
app.get('/api/users', async (req, res) => {
    console.log('--- Petición para obtener TODOS los usuarios recibida ---');
    const { rol } = req.query; // Obtener el parámetro de consulta 'rol'

    let client;
    try {
        client = await pool.connect();
        let queryText = 'SELECT id, email, nombre, apellido, telefono, direccion, rol, estado FROM public.usuarios'; // Añadimos 'estado'
        const queryParams = [];
        const conditions = []; // Inicializar la array de condiciones
        let paramIndex = 1;

        if (rol) {
            conditions.push(`rol = $${paramIndex++}`);
            queryParams.push(rol);
        }
        
        if (conditions.length > 0) { // Solo añadir WHERE si hay condiciones
            queryText += ` WHERE ${conditions.join(' AND ')}`;
        }
        queryText += ' ORDER BY id ASC;'; // Ordenar para consistencia

        const result = await client.query(queryText, queryParams);
        client.release();

        res.status(200).json({
            message: 'Usuarios obtenidos exitosamente',
            users: result.rows
        });
        console.log(`DEBUG: Se encontraron ${result.rows.length} usuarios (filtro por rol: ${rol || 'ninguno'}).`);

    } catch (err) {
        console.error('ERROR CRÍTICO al obtener todos los usuarios:', err);
        res.status(500).json({ error: 'Error interno del servidor al obtener usuarios.', details: err.message });
    }
    console.log('--- Fin de petición de obtener TODOS los usuarios ---');
});

// 13. Ruta para CREAR un nuevo usuario (para uso administrativo)
app.post('/api/users', async (req, res) => {
    console.log('--- Petición para CREAR nuevo usuario (ADMIN) recibida ---');
    const { email, password, nombre, apellido, telefono, direccion, rol } = req.body;

    if (!email || !password || !nombre || !apellido || !rol) {
        return res.status(400).json({ message: 'Campos obligatorios (email, password, nombre, apellido, rol) son requeridos.' });
    }

    // Validar el rol
    const rolesValidos = ['cliente', 'distribuidor', 'admin'];
    if (!rolesValidos.includes(rol.toLowerCase())) {
        return res.status(400).json({ message: 'Rol de usuario inválido. Los roles permitidos son: cliente, distribuidor, admin.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const client = await pool.connect();
        const result = await client.query(
            `INSERT INTO public.usuarios (email, password_hash, nombre, apellido, telefono, direccion, rol, estado)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'activo')
             RETURNING id, email, nombre, apellido, telefono, direccion, rol, estado;`, // Añadimos 'estado'
            [email, hashedPassword, nombre, apellido, telefono || null, direccion || null, rol.toLowerCase()]
        );
        client.release();

        res.status(201).json({
            message: 'Usuario creado exitosamente',
            user: result.rows[0]
        });
        console.log('DEBUG: Nuevo usuario creado:', result.rows[0].email, 'Rol:', result.rows[0].rol);

    } catch (err) {
        if (err.code === '23505') { // Error de duplicidad (email)
            return res.status(409).json({ message: 'El correo electrónico ya está registrado por otro usuario.' });
        }
        console.error('ERROR CRÍTICO al crear nuevo usuario (ADMIN):', err);
        res.status(500).json({ error: 'Error interno del servidor al crear usuario.', details: err.message });
    }
    console.log('--- Fin de petición de CREAR nuevo usuario (ADMIN) ---');
});

// 14. Ruta para ACTUALIZAR un usuario por ID (para uso administrativo)
app.put('/api/users/:id', async (req, res) => {
    console.log('--- Petición para ACTUALIZAR usuario (ADMIN) recibida para ID:', req.params.id, '---');
    const { id } = req.params;
    const { email, password, nombre, apellido, telefono, direccion, rol, estado } = req.body; // Añadimos 'estado'

    // Al menos un campo debe ser proporcionado para actualizar
    if (!email && !password && !nombre && !apellido && telefono === undefined && direccion === undefined && !rol && !estado) {
        return res.status(400).json({ message: 'Se requiere al menos un campo para actualizar.' });
    }

    // Validar el rol si se proporciona
    if (rol && !['cliente', 'distribuidor', 'admin'].includes(rol.toLowerCase())) {
        return res.status(400).json({ message: 'Rol de usuario inválido. Los roles permitidos son: cliente, distribuidor, admin.' });
    }

    // Validar el estado si se proporciona
    if (estado && !['activo', 'suspendido'].includes(estado.toLowerCase())) {
        return res.status(400).json({ message: 'Estado de usuario inválido. Los estados permitidos son: activo, suspendido.' });
    }

    try {
        const client = await pool.connect();
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;

        if (email) {
            updateFields.push(`email = $${paramIndex++}`);
            updateValues.push(email);
        }
        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            updateFields.push(`password_hash = $${paramIndex++}`);
            updateValues.push(hashedPassword);
        }
        if (nombre) {
            updateFields.push(`nombre = $${paramIndex++}`);
            updateValues.push(nombre);
        }
        if (apellido) {
            updateFields.push(`apellido = $${paramIndex++}`);
            updateValues.push(apellido);
        }
        if (telefono !== undefined) {
            updateFields.push(`telefono = $${paramIndex++}`);
            updateValues.push(telefono);
        }
        if (direccion !== undefined) {
            updateFields.push(`direccion = $${paramIndex++}`);
            updateValues.push(direccion);
        }
        if (rol) {
            updateFields.push(`rol = $${paramIndex++}`);
            updateValues.push(rol.toLowerCase());
        }
        // NUEVO: Añadir el campo estado para actualización
        if (estado) {
            updateFields.push(`estado = $${paramIndex++}`);
            updateValues.push(estado.toLowerCase());
        }

        updateFields.push(`updated_at = CURRENT_TIMESTAMP`); // Actualizar la marca de tiempo

        const queryText = `UPDATE public.usuarios SET ${updateFields.join(', ')} WHERE id = $${paramIndex} RETURNING id, email, nombre, apellido, telefono, direccion, rol, estado;`; // Aseguramos que 'estado' se devuelve
        updateValues.push(id);

        const result = await client.query(queryText, updateValues);
        client.release();

        const updatedUser = result.rows[0];

        if (!updatedUser) {
            console.log('DEBUG: Usuario no encontrado para actualización para ID:', id);
            return res.status(404).json({ message: 'Usuario no encontrado para actualizar.' });
        }

        res.status(200).json({
            message: 'Usuario actualizado exitosamente',
            user: updatedUser
        });
        console.log('DEBUG: Usuario actualizado:', updatedUser.email, 'Rol:', updatedUser.rol, 'Estado:', updatedUser.estado);

    } catch (err) {
        if (err.code === '23505') { // Error de duplicidad (email)
            return res.status(409).json({ message: 'El correo electrónico ya está registrado por otro usuario.' });
        }
        console.error('ERROR CRÍTICO al actualizar usuario (ADMIN):', err);
        res.status(500).json({ error: 'Error interno del servidor al actualizar usuario.', details: err.message });
    }
    console.log('--- Fin de petición de ACTUALIZAR usuario (ADMIN) ---');
});

// NUEVO: 14.1. Ruta para cambiar el estado de suspensión de un usuario
app.put('/api/users/:id/status', async (req, res) => {
    console.log('--- Petición para cambiar estado de usuario recibida para ID:', req.params.id, '---');
    const { id } = req.params;
    const { isSuspended } = req.body; // Viene del frontend como un booleano

    if (typeof isSuspended !== 'boolean') {
        return res.status(400).json({ message: 'El campo isSuspended es requerido y debe ser un booleano.' });
    }

    const newEstado = isSuspended ? 'suspendido' : 'activo';

    try {
        const client = await pool.connect();
        const result = await client.query(
            `UPDATE public.usuarios SET estado = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, email, nombre, apellido, telefono, direccion, rol, estado;`,
            [newEstado, id]
        );
        client.release();

        const updatedUser = result.rows[0];

        if (!updatedUser) {
            console.log('DEBUG: Usuario no encontrado para actualización de estado para ID:', id);
            return res.status(404).json({ message: 'Usuario no encontrado para actualizar su estado.' });
        }

        res.status(200).json({
            message: 'Estado del usuario actualizado exitosamente',
            user: updatedUser
        });
        console.log('DEBUG: Estado del usuario actualizado:', updatedUser.email, 'Estado:', updatedUser.estado);

    } catch (err) {
        console.error('ERROR CRÍTICO al cambiar estado del usuario:', err);
        res.status(500).json({ error: 'Error interno del servidor al cambiar el estado del usuario.', details: err.message });
    }
    console.log('--- Fin de petición de cambiar estado del usuario ---');
});


// 15. Ruta para ELIMINAR un usuario por ID (para uso administrativo)
app.delete('/api/users/:id', async (req, res) => {
    console.log('--- Petición para ELIMINAR usuario (ADMIN) recibida para ID:', req.params.id, '---');
    const { id } = req.params;

    try {
        const client = await pool.connect();
        const result = await client.query(
            'DELETE FROM public.usuarios WHERE id = $1 RETURNING id;',
            [id]
        );
        client.release();

        if (result.rowCount === 0) {
            console.log('DEBUG: Usuario no encontrado para eliminar para ID:', id);
            return res.status(404).json({ message: 'Usuario no encontrado para eliminar.' });
        }

        res.status(200).json({ message: 'Usuario eliminado exitosamente', idEliminado: id });
        console.log('DEBUG: Usuario eliminado exitosamente con ID:', id);

    } catch (err) {
        console.error('ERROR CRÍTICO al eliminar usuario (ADMIN):', err);
        res.status(500).json({ error: 'Error interno del servidor al eliminar usuario.', details: err.message });
    }
    console.log('--- Fin de petición de ELIMINAR usuario (ADMIN) ---');
});

// --- NUEVAS RUTAS PARA REPORTES DE VENTAS ---

// 16. Ruta para obtener pedidos filtrados por estado y/o fecha
app.get('/api/admin/pedidos', async (req, res) => {
    console.log('--- Petición para obtener pedidos filtrados (ADMIN) recibida ---');
    const { estado, fechaInicio, fechaFin } = req.query; // Parámetros de consulta

    let client;
    try {
        client = await pool.connect();
        let queryText = `
            SELECT 
                id, 
                user_id, 
                nombre_cliente, 
                telefono_cliente, 
                direccion_envio, 
                fecha_pedido, 
                botellones_18l, 
                botellones_12l, 
                botellones_5l, 
                metodo_pago, 
                banco_seleccionado, 
                referencia, 
                costo_total, 
                estado_pedido
            FROM public.pedidos
        `;
        const queryParams = [];
        const conditions = [];
        let paramIndex = 1;

        if (estado) {
            // Asegurarse de que el estado sea uno de los válidos para evitar inyección SQL
            const estadosValidos = ['pendiente', 'aceptado', 'en proceso', 'en camino', 'entregado', 'rechazado'];
            if (estadosValidos.includes(estado.toLowerCase())) {
                conditions.push(`estado_pedido = $${paramIndex++}`);
                queryParams.push(estado.toLowerCase());
            } else {
                return res.status(400).json({ message: 'Estado de pedido inválido para el filtro.' });
            }
        }

        if (fechaInicio) {
            conditions.push(`fecha_pedido >= $${paramIndex++}`);
            queryParams.push(fechaInicio); // Formato YYYY-MM-DD
        }

        if (fechaFin) {
            // Para incluir todo el día de fechaFin, sumar un día
            const endOfDay = new Date(fechaFin);
            endOfDay.setDate(endOfDay.getDate() + 1);
            conditions.push(`fecha_pedido < $${paramIndex++}`);
            queryParams.push(endOfDay.toISOString().split('T')[0]); // Asegurar formato YYYY-MM-DD
        }

        if (conditions.length > 0) {
            queryText += ` WHERE ${conditions.join(' AND ')}`;
        }

        queryText += ' ORDER BY fecha_pedido DESC;';

        const result = await client.query(queryText, queryParams);
        client.release();

        res.status(200).json({
            message: 'Pedidos obtenidos exitosamente',
            pedidos: result.rows
        });
        console.log(`DEBUG: Se encontraron ${result.rows.length} pedidos con los filtros aplicados.`);

    } catch (err) {
        console.error('ERROR CRÍTICO al obtener pedidos filtrados (ADMIN):', err);
        res.status(500).json({ error: 'Error interno del servidor al obtener pedidos.', details: err.message });
    }
    console.log('--- Fin de petición de obtener pedidos filtrados (ADMIN) ---');
});

// 17. Ruta para obtener el resumen de ingresos y botellones por período
app.get('/api/admin/ventas/resumen', async (req, res) => {
    console.log('--- Petición para obtener resumen de ventas (ADMIN) recibida ---');
    const { periodo } = req.query; // 'hoy', 'semana', 'mes', 'total'

    let client;
    try {
        client = await pool.connect();
        // Modificación: Incluir 'aceptado' en el filtro de estado y sumar botellones
        let queryText = `
            SELECT 
                COALESCE(SUM(costo_total), 0) AS total_ingresos,
                COALESCE(SUM(botellones_18l), 0) AS total_18l,
                COALESCE(SUM(botellones_12l), 0) AS total_12l,
                COALESCE(SUM(botellones_5l), 0) AS total_5l
            FROM public.pedidos 
            WHERE estado_pedido IN ('entregado', 'aceptado')
        `;
        const queryParams = [];
        let paramIndex = 1;
        
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Inicio del día

        switch (periodo) {
            case 'hoy':
                queryText += ` AND fecha_pedido >= $${paramIndex++}`;
                queryParams.push(today.toISOString());
                break;
            case 'semana':
                // Lunes de la semana actual
                const firstDayOfWeek = new Date(today);
                firstDayOfWeek.setDate(today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1)); // Lunes (1) o Lunes de la semana anterior si es Domingo (0)
                firstDayOfWeek.setHours(0, 0, 0, 0);
                queryText += ` AND fecha_pedido >= $${paramIndex++}`;
                queryParams.push(firstDayOfWeek.toISOString());
                break;
            case 'mes':
                // Primer día del mes actual
                const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
                queryText += ` AND fecha_pedido >= $${paramIndex++}`;
                queryParams.push(firstDayOfMonth.toISOString());
                break;
            case 'total':
                // No se añade filtro de fecha, se obtiene el total de todos los tiempos
                break;
            default:
                // Por defecto, si no se especifica un período válido, se puede devolver el total general
                // o un error, dependiendo de la lógica de negocio. Aquí, haremos el total general.
                break;
        }

        const result = await client.query(queryText, queryParams);
        client.release();

        const summary = result.rows[0];
        res.status(200).json({
            message: `Resumen de ingresos para el período '${periodo || "total"}' obtenido exitosamente`,
            total: parseFloat(summary.total_ingresos).toFixed(2), // Formatear a 2 decimales
            botellones_18l: parseInt(summary.total_18l),
            botellones_12l: parseInt(summary.total_12l),
            botellones_5l: parseInt(summary.total_5l)
        });
        console.log(`DEBUG: Resumen de ingresos para '${periodo || "total"}': ${summary.total_ingresos}, 18L: ${summary.total_18l}, 12L: ${summary.total_12l}, 5L: ${summary.total_5l}`);

    } catch (err) {
        console.error('ERROR CRÍTICO al obtener resumen de ventas (ADMIN):', err);
        res.status(500).json({ error: 'Error interno del servidor al obtener resumen de ventas.', details: err.message });
    }
    console.log('--- Fin de petición de resumen de ventas (ADMIN) ---');
});


app.listen(port, () => {
    console.log(`Servidor backend escuchando en http://localhost:${port}`);
    console.log('El pool de conexiones a la base de datos se inicializa, pero las conexiones individuales se establecen bajo demanda.');
    console.log('Para probar la conexión a la DB, visita http://localhost:3000 en tu navegador.');
});

