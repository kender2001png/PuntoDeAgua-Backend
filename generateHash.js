const bcrypt = require('bcryptjs');

// Contraseña que quieres usar para el distribuidor
const password = 'golf4runner'; // ¡Esta es la contraseña que has especificado!

bcrypt.hash(password, 10, (err, hash) => {
    if (err) {
        console.error('Error al hashear la contraseña:', err);
        return;
    }
    console.log('Hash de la contraseña:', hash);
    console.log('Copia este hash para insertarlo en la base de datos.');
});