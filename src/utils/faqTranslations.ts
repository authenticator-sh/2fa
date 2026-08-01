import { type Language } from './i18n';

export interface FAQItem {
  question: string;
  answer: string;
  id?: string;
}

const faqData: Partial<Record<Language, FAQItem[]>> = {
  en: [
    {
      question: 'How do I add a new account?',
      answer: 'You can add an account in two ways:\n\n1. Manual Entry: Click "Add Account", enter the account name and secret key from your service\'s 2FA setup page.\n\n2. QR Code: Click "Add Account", switch to the "QR Code" tab, and upload a screenshot or photo of the QR code shown during 2FA setup.',
    },
    {
      question: 'Where do I find the secret key?',
      answer: 'When setting up 2FA on any service (Gmail, GitHub, etc.):\n\n1. Look for "Can\'t scan the QR code?" or "Enter manually" link\n2. Click it to reveal the secret key\n3. The key is usually 16-32 characters (letters A-Z and numbers 2-7)\n4. Example: JBSWY3DPEHPK3PXP',
    },
    {
      question: 'Why are my codes not working?',
      answer: 'If codes are rejected, the most common reason is time synchronization:\n\n• Your computer clock must be accurate (within 30 seconds)\n• TOTP codes are time-based and expire every 30 seconds\n• Check if you see a time warning at the top of the app\n• Fix: Update your system time or enable automatic time sync',
    },
    {
      question: 'How do I backup my accounts?',
      answer: 'To backup your accounts:\n\n1. Click the Settings icon (gear)\n2. Click "Export"\n3. Choose how to save the file:\n\n• Protected with a password (recommended) — the file is useless to anyone who does not know the password. Remember it: the file cannot be opened without it.\n• Plain file — readable by anyone who opens it. Only for a location you fully control.\n\nA plain export contains your secret keys in the clear. Anyone holding that file can generate your 2FA codes.'
    },
    {
      question: 'How do I restore from backup?',
      answer: 'To restore accounts from a backup:\n\n1. Click "import from backup" on the main screen\n2. Select your backup JSON file\n3. If the file is password protected, enter its password when asked\n4. All accounts will be imported\n\nNote: This will add to your existing accounts, not replace them.',
    },
    {
      question: 'Can I use this on multiple devices?',
      answer: 'Yes! If you enable Chrome Sync:\n\n• Your accounts will sync across all your Chrome browsers\n• You can also manually export and import on different devices\n• Note: Local storage is also used as a backup',
    },
    {
      question: 'What if I delete an account by mistake?',
      answer: 'If you accidentally delete an account:\n\n1. Check your automatic backups (stored for 7 days)\n2. Or restore from your manual backup file\n3. If no backup exists, you\'ll need to disable and re-enable 2FA on that service\n\nTip: Always export a backup before making major changes!',
    },
    {
      id: 'time-sync',
      question: 'Why do I see a time sync warning? How do I fix it?',
      answer: 'TOTP codes are generated from your device clock, so if it drifts more than ~30 seconds from real time, services will reject your codes.\n\nHow to fix it:\n\n• macOS: System Settings → General → Date & Time → turn on "Set time and date automatically"\n• Windows: Settings → Time & language → Date & time → turn on "Set time automatically", then click "Sync now"\n• Linux: enable NTP / automatic date & time in your settings\n\nAfter syncing, reopen the extension — the warning disappears and your codes will be accepted again. Only your device clock needs fixing; the codes themselves are still generated offline.',
    },
    {
      question: 'What\'s the difference between Algorithm/Digits/Period?',
      answer: 'These are advanced settings (usually defaults work):\n\n• Algorithm: Hash function used to derive the code (SHA1 is standard)\n• Digits: Code length (6 is most common, some use 8)\n• Period: How long codes are valid (30 seconds standard)\n\nMost services use: SHA1, 6 digits, 30 seconds.',
    },
    {
      question: 'Is my data secure?',
      answer: 'Your accounts live only on your device. We have no servers and never receive your data.\n\n• Secret keys never leave your device\n• Automatic local backups (last 7) in case something goes wrong\n• Stored in Chrome storage, with sync as an optional second copy\n\nBy default your codes are stored unencrypted and are protected by your computer login and Chrome profile — the same as most authenticator extensions. For stronger protection, turn on password protection in Settings: your codes are then encrypted on your device, including the backups, and cannot be read without your password.',
    },
    {
      id: 'password-protection',
      question: 'How do I protect my codes with a password?',
      answer: 'Open Settings and turn on "Password protection". Your codes are then scrambled on this device, so nobody can read them without your password — not someone using your computer, not a virus that steals browser data, and not through your Google account sync.\n\nYou will also get a recovery code. Save it somewhere outside this browser: it is the only way back in if you forget your password. We cannot reset it for you.\n\nYou choose how often the password is asked for: every time, after a few minutes idle, or once until the browser closes. You can turn the protection off again at any time with your password.',
    },
    {
      question: 'Can I import from Google Authenticator?',
      answer: 'Yes! Google Authenticator has an export feature:\n\n1. Open Google Authenticator app\n2. Tap "Transfer accounts" → "Export accounts"\n3. Select accounts to export\n4. Take a screenshot of the QR code\n5. In this app: Add Account → QR Code → upload the screenshot',
    },
    {
      question: 'What happens if I lose my backup?',
      answer: 'If you lose access to this extension and have no backup:\n\n1. You\'ll need to disable 2FA on each affected service\n2. Then re-enable 2FA and add accounts again\n3. Keep recovery codes from services in a safe place\n\nPrevention: Export backups regularly and store them securely!',
    },
  ],
  zh: [
    {
      question: '如何添加新账户？',
      answer: '您可以通过两种方式添加账户：\n\n1. 手动输入：点击“添加账户”，输入账户名称和您服务的 2FA 设置页面上的密钥。\n\n2. QR Code：点击“添加账户”，切换到“QR Code”标签页，然后上传 2FA 设置期间显示的 QR Code 的截图或照片。',
    },
    {
      question: '在哪里可以找到密钥？',
      answer: '在任何服务（Gmail、GitHub 等）上设置 2FA 时：\n\n1. 查找“无法扫描 QR Code？”或“手动输入”链接\n2. 点击它以显示密钥\n3. 密钥通常为 16-32 个字符（字母 A-Z 和数字 2-7）\n4. 示例：JBSWY3DPEHPK3PXP',
    },
    {
      question: '为什么我的验证码不能用？',
      answer: '如果验证码被拒绝，最常见的原因是时间同步问题：\n\n• 您的计算机时钟必须准确（误差不超过 30 秒）\n• TOTP 验证码是基于时间的，每 30 秒过期\n• 检查应用顶部是否显示时间警告\n• 解决方法：更新系统时间或启用自动时间同步',
    },
    {
      question: '如何备份我的账户？',
      answer: '备份您的账户：\n\n1. 点击设置图标（齿轮）\n2. 点击“导出”\n3. 选择保存方式：\n\n• 用密码保护（推荐）——不知道密码的人拿到文件也没有用。请记住密码：没有它就打不开该文件。\n• 普通文件——任何打开它的人都能读取。仅适合放在你完全掌控的位置。\n\n普通导出会以明文包含你的密钥。任何拿到该文件的人都能生成你的 2FA 验证码。',
    },
    {
      question: '如何从备份恢复？',
      answer: '从备份恢复账户：\n\n1. 在主屏幕上点击“从备份导入”\n2. 选择您的备份 JSON 文件\n3. 如果文件有密码保护，按提示输入密码\n4. 所有账户将被导入\n\n注意：这将添加到您现有的账户中，而不是替换它们。',
    },
    {
      question: '可以在多个设备上使用吗？',
      answer: '可以！如果您启用 Chrome Sync：\n\n• 您的账户将在所有 Chrome 浏览器之间同步\n• 您也可以在不同设备上手动导出和导入\n• 注意：本地存储也用作备份',
    },
    {
      question: '如果我误删了一个账户怎么办？',
      answer: '如果您不小心删除了一个账户：\n\n1. 检查自动备份（保存 7 天）\n2. 或从手动备份文件恢复\n3. 如果没有备份，您需要在该服务上禁用并重新启用 2FA\n\n提示：在进行重大更改之前，请始终导出备份！',
    },
    {
      id: 'time-sync',
      question: '为什么我看到时间同步警告？如何修复？',
      answer: 'TOTP 验证码根据您设备的时钟生成，因此如果时钟与真实时间相差超过约 30 秒，服务将拒绝您的验证码。\n\n如何修复：\n\n• macOS：系统设置 → 通用 → 日期与时间 → 打开"自动设置日期与时间"\n• Windows：设置 → 时间和语言 → 日期和时间 → 打开"自动设置时间"，然后点击"立即同步"\n• Linux：在设置中启用 NTP / 自动日期与时间\n\n同步后重新打开扩展——警告消失，您的验证码将再次被接受。只需修正设备时钟；验证码本身仍然离线生成。',
    },
    {
      question: '算法/位数/周期之间有什么区别？',
      answer: '这些是高级设置（通常默认值即可）：\n\n• 算法：用于生成验证码的哈希函数（SHA1 是标准）\n• 位数：验证码长度（6 位最常见，部分使用 8 位）\n• 周期：验证码有效时长（30 秒为标准）\n\n大多数服务使用：SHA1、6 位、30 秒。',
    },
    {
      question: '我的数据安全吗？',
      answer: '您的账户只保存在您的设备上。我们没有服务器，也从不接收您的数据。\n\n• 密钥永远不会离开您的设备\n• 自动本地备份（保留最近 7 份），以防出现意外\n• 保存在 Chrome 存储中，同步作为可选的第二份副本\n\n默认情况下，您的验证码以未加密的形式保存，依靠您的电脑登录和 Chrome 配置文件来保护——与大多数验证器扩展相同。若需更强的保护，请在设置中开启密码保护：此后您的验证码（包括备份）会在设备上加密，没有密码便无法读取。',
    },
    {
      id: 'password-protection',
      question: '如何用密码保护我的验证码？',
      answer: '打开设置并开启“密码保护”。此后你的验证码会在本设备上加密，没有密码谁也读不了——无论是使用你电脑的人、窃取浏览器数据的病毒，还是通过你的 Google 账号同步。\n\n你还会得到一个恢复码。请把它保存在这个浏览器之外的地方：如果忘记密码，它是唯一的找回方式。我们无法为你重置。\n\n你可以选择多久要求输入一次密码：每次、闲置几分钟后，或直到关闭浏览器。随时可以用密码再次关闭该保护。',
    },
    {
      question: '可以从 Google Authenticator 导入吗？',
      answer: '可以！Google Authenticator 有导出功能：\n\n1. 打开 Google Authenticator 应用\n2. 点击“转移账户” → “导出账户”\n3. 选择要导出的账户\n4. 对 QR Code 进行截图\n5. 在本应用中：添加账户 → QR Code → 上传截图',
    },
    {
      question: '如果我丢失了备份怎么办？',
      answer: '如果您无法访问此扩展程序且没有备份：\n\n1. 您需要在每个受影响的服务上禁用 2FA\n2. 然后重新启用 2FA 并再次添加账户\n3. 将服务的恢复代码保存在安全的地方\n\n预防措施：定期导出备份并安全存储！',
    },
  ],
  es: [
    {
      question: '¿Cómo añado una nueva cuenta?',
      answer: 'Puede añadir una cuenta de dos maneras:\n\n1. Entrada manual: Haga clic en "Añadir cuenta", ingrese el nombre de la cuenta y la clave secreta de la página de configuración de 2FA de su servicio.\n\n2. QR Code: Haga clic en "Añadir cuenta", cambie a la pestaña "QR Code" y suba una captura de pantalla o foto del QR Code mostrado durante la configuración de 2FA.',
    },
    {
      question: '¿Dónde encuentro la clave secreta?',
      answer: 'Al configurar 2FA en cualquier servicio (Gmail, GitHub, etc.):\n\n1. Busque el enlace "¿No puede escanear el QR Code?" o "Ingresar manualmente"\n2. Haga clic para revelar la clave secreta\n3. La clave generalmente tiene 16-32 caracteres (letras A-Z y números 2-7)\n4. Ejemplo: JBSWY3DPEHPK3PXP',
    },
    {
      question: '¿Por qué mis códigos no funcionan?',
      answer: 'Si los códigos son rechazados, la razón más común es la sincronización de tiempo:\n\n• El reloj de su computadora debe ser preciso (dentro de 30 segundos)\n• Los códigos TOTP están basados en el tiempo y expiran cada 30 segundos\n• Verifique si ve una advertencia de tiempo en la parte superior de la aplicación\n• Solución: Actualice la hora del sistema o habilite la sincronización automática de tiempo',
    },
    {
      question: '¿Cómo hago una copia de seguridad de mis cuentas?',
      answer: 'Para hacer una copia de seguridad de sus cuentas:\n\n1. Haga clic en el icono de Configuración (engranaje)\n2. Haga clic en el botón "Exportar"\n3. Elija cómo guardar el archivo:\n\n• Protegido con contraseña (recomendado): el archivo no sirve de nada a quien no la sepa. Recuérdela: sin ella el archivo no se puede abrir.\n• Archivo normal: legible por cualquiera que lo abra. Solo para un lugar que usted controle.\n\nUna exportación normal contiene sus claves secretas en texto claro. Cualquiera con ese archivo puede generar sus códigos 2FA.',
    },
    {
      question: '¿Cómo restauro desde una copia de seguridad?',
      answer: 'Para restaurar cuentas desde una copia de seguridad:\n\n1. Haga clic en "importar desde copia de seguridad" en la pantalla principal\n2. Seleccione su archivo JSON de respaldo\n3. Todas las cuentas serán importadas\n\nNota: Esto se añadirá a sus cuentas existentes, no las reemplazará.',
    },
    {
      question: '¿Puedo usar esto en múltiples dispositivos?',
      answer: '¡Sí! Si habilita Chrome Sync:\n\n• Sus cuentas se sincronizarán en todos sus navegadores Chrome\n• También puede exportar e importar manualmente en diferentes dispositivos\n• Nota: El almacenamiento local también se usa como respaldo',
    },
    {
      question: '¿Qué pasa si elimino una cuenta por error?',
      answer: 'Si elimina accidentalmente una cuenta:\n\n1. Verifique sus copias de seguridad automáticas (almacenadas por 7 días)\n2. O restaure desde su archivo de respaldo manual\n3. Si no existe respaldo, deberá desactivar y volver a activar 2FA en ese servicio\n\nConsejo: ¡Siempre exporte una copia de seguridad antes de hacer cambios importantes!',
    },
    {
      id: 'time-sync',
      question: '¿Por qué veo una advertencia de sincronización de tiempo? ¿Cómo la soluciono?',
      answer: 'Los códigos TOTP se generan a partir del reloj de tu dispositivo, así que si se desvía más de ~30 segundos de la hora real, los servicios rechazarán tus códigos.\n\nCómo solucionarlo:\n\n• macOS: Configuración del Sistema → General → Fecha y hora → activa "Establecer fecha y hora automáticamente"\n• Windows: Configuración → Hora e idioma → Fecha y hora → activa "Establecer la hora automáticamente" y pulsa "Sincronizar ahora"\n• Linux: activa NTP / fecha y hora automática en los ajustes\n\nTras sincronizar, vuelve a abrir la extensión: la advertencia desaparece y tus códigos se aceptarán de nuevo. Solo hay que corregir el reloj del dispositivo; los códigos se siguen generando sin conexión.',
    },
    {
      question: '¿Cuál es la diferencia entre Algoritmo/Dígitos/Período?',
      answer: 'Estas son configuraciones avanzadas (generalmente los valores predeterminados funcionan):\n\n• Algoritmo: Función hash usada para generar el código (SHA1 es el estándar)\n• Dígitos: Longitud del código (6 es lo más común, algunos usan 8)\n• Período: Cuánto tiempo son válidos los códigos (30 segundos estándar)\n\nLa mayoría de servicios usan: SHA1, 6 dígitos, 30 segundos.',
    },
    {
      question: '¿Mis datos están seguros?',
      answer: 'Sus cuentas solo residen en su dispositivo. No tenemos servidores y nunca recibimos sus datos.\n\n• Las claves secretas nunca salen de su dispositivo\n• Copias de seguridad locales automáticas (las 7 últimas) por si algo sale mal\n• Guardadas en el almacenamiento de Chrome, con la sincronización como segunda copia opcional\n\nDe forma predeterminada, sus códigos se guardan sin cifrar y están protegidos por el inicio de sesión de su ordenador y su perfil de Chrome, igual que en la mayoría de extensiones de autenticación. Para una protección más fuerte, active la protección con contraseña en Ajustes: sus códigos, incluidas las copias de seguridad, se cifran en su dispositivo y no se pueden leer sin su contraseña.',
    },
    {
      id: 'password-protection',
      question: '¿Cómo protejo mis códigos con una contraseña?',
      answer: 'Abra Ajustes y active "Protección con contraseña". Sus códigos quedan cifrados en este dispositivo, así que nadie puede leerlos sin su contraseña: ni quien use su ordenador, ni un virus que robe los datos del navegador, ni a través de la sincronización de su cuenta de Google.\n\nTambién recibirá un código de recuperación. Guárdelo fuera de este navegador: es la única forma de volver a entrar si olvida la contraseña. No podemos restablecerla por usted.\n\nUsted elige con qué frecuencia se pide la contraseña: siempre, tras unos minutos de inactividad, o una vez hasta cerrar el navegador. Puede desactivar la protección cuando quiera con su contraseña.',
    },
    {
      question: '¿Puedo importar desde Google Authenticator?',
      answer: '¡Sí! Google Authenticator tiene una función de exportación:\n\n1. Abra la aplicación Google Authenticator\n2. Toque "Transferir cuentas" → "Exportar cuentas"\n3. Seleccione las cuentas a exportar\n4. Tome una captura de pantalla del QR Code\n5. En esta aplicación: Añadir cuenta → QR Code → suba la captura de pantalla',
    },
    {
      question: '¿Qué pasa si pierdo mi copia de seguridad?',
      answer: 'Si pierde el acceso a esta extensión y no tiene respaldo:\n\n1. Deberá desactivar 2FA en cada servicio afectado\n2. Luego volver a activar 2FA y añadir las cuentas de nuevo\n3. Guarde los códigos de recuperación de los servicios en un lugar seguro\n\n¡Prevención: Exporte copias de seguridad regularmente y almacénelas de forma segura!',
    },
  ],
  hi: [
    {
      question: 'मैं नया खाता कैसे जोड़ूँ?',
      answer: 'आप दो तरीकों से खाता जोड़ सकते हैं:\n\n1. मैनुअल एंट्री: "खाता जोड़ें" पर क्लिक करें, खाते का नाम और अपनी सेवा के 2FA सेटअप पेज से गुप्त कुंजी दर्ज करें।\n\n2. QR Code: "खाता जोड़ें" पर क्लिक करें, "QR Code" टैब पर स्विच करें, और 2FA सेटअप के दौरान दिखाए गए QR Code का स्क्रीनशॉट या फोटो अपलोड करें।',
    },
    {
      question: 'गुप्त कुंजी कहाँ मिलेगी?',
      answer: 'किसी भी सेवा (Gmail, GitHub, आदि) पर 2FA सेटअप करते समय:\n\n1. "QR Code स्कैन नहीं कर सकते?" या "मैनुअल रूप से दर्ज करें" लिंक खोजें\n2. गुप्त कुंजी दिखाने के लिए उस पर क्लिक करें\n3. कुंजी आमतौर पर 16-32 अक्षरों की होती है (अक्षर A-Z और संख्याएँ 2-7)\n4. उदाहरण: JBSWY3DPEHPK3PXP',
    },
    {
      question: 'मेरे कोड काम क्यों नहीं कर रहे?',
      answer: 'यदि कोड अस्वीकार हो रहे हैं, तो सबसे आम कारण समय सिंक्रनाइज़ेशन है:\n\n• आपके कंप्यूटर की घड़ी सटीक होनी चाहिए (30 सेकंड के अंदर)\n• TOTP कोड समय-आधारित होते हैं और हर 30 सेकंड में समाप्त हो जाते हैं\n• जाँचें कि ऐप के शीर्ष पर समय चेतावनी दिख रही है\n• समाधान: सिस्टम समय अपडेट करें या स्वचालित समय सिंक सक्षम करें',
    },
    {
      question: 'मैं अपने खातों का बैकअप कैसे लूँ?',
      answer: 'अपने खातों का बैकअप लेने के लिए:\n\n1. सेटिंग्स आइकन (गियर) पर क्लिक करें\n2. "एक्सपोर्ट" बटन पर क्लिक करें\n3. चुनें कि फ़ाइल कैसे सहेजनी है:\n\n• पासवर्ड से सुरक्षित (अनुशंसित) — पासवर्ड न जानने वाले के लिए फ़ाइल बेकार है। पासवर्ड याद रखें: उसके बिना फ़ाइल नहीं खुलेगी।\n• सामान्य फ़ाइल — जो भी खोलेगा पढ़ सकेगा। केवल उस जगह के लिए जो पूरी तरह आपके नियंत्रण में हो।\n\nसामान्य एक्सपोर्ट में आपकी गुप्त कुंजियाँ खुले रूप में होती हैं। वह फ़ाइल जिसके पास हो, वह आपके 2FA कोड बना सकता है।',
    },
    {
      question: 'बैकअप से रिस्टोर कैसे करें?',
      answer: 'बैकअप से खाते रिस्टोर करने के लिए:\n\n1. मुख्य स्क्रीन पर "बैकअप से आयात करें" पर क्लिक करें\n2. अपनी बैकअप JSON फाइल चुनें\n3. सभी खाते आयात हो जाएंगे\n\nनोट: यह आपके मौजूदा खातों में जोड़ा जाएगा, उन्हें बदलेगा नहीं।',
    },
    {
      question: 'क्या मैं इसे कई डिवाइसों पर उपयोग कर सकता/सकती हूँ?',
      answer: 'हाँ! यदि आप Chrome Sync सक्षम करते हैं:\n\n• आपके खाते आपके सभी Chrome ब्राउज़रों में सिंक होंगे\n• आप विभिन्न डिवाइसों पर मैनुअल रूप से एक्सपोर्ट और आयात भी कर सकते हैं\n• नोट: लोकल स्टोरेज का उपयोग बैकअप के रूप में भी किया जाता है',
    },
    {
      question: 'यदि मैं गलती से कोई खाता हटा दूँ तो?',
      answer: 'यदि आप गलती से कोई खाता हटा देते हैं:\n\n1. अपने स्वचालित बैकअप जाँचें (7 दिनों तक संग्रहीत)\n2. या अपनी मैनुअल बैकअप फाइल से रिस्टोर करें\n3. यदि कोई बैकअप नहीं है, तो आपको उस सेवा पर 2FA अक्षम करके पुनः सक्षम करना होगा\n\nसुझाव: बड़े बदलाव करने से पहले हमेशा बैकअप एक्सपोर्ट करें!',
    },
    {
      id: 'time-sync',
      question: 'मुझे समय सिंक चेतावनी क्यों दिख रही है? इसे कैसे ठीक करें?',
      answer: 'TOTP कोड आपके डिवाइस की घड़ी से बनते हैं, इसलिए यदि यह वास्तविक समय से ~30 सेकंड से अधिक भटक जाए, तो सेवाएं आपके कोड अस्वीकार कर देंगी।\n\nइसे कैसे ठीक करें:\n\n• macOS: सिस्टम सेटिंग्स → General → Date & Time → "Set time and date automatically" चालू करें\n• Windows: Settings → Time & language → Date & time → "Set time automatically" चालू करें, फिर "Sync now" पर क्लिक करें\n• Linux: सेटिंग्स में NTP / स्वचालित दिनांक और समय सक्षम करें\n\nसिंक करने के बाद एक्सटेंशन फिर से खोलें — चेतावनी गायब हो जाएगी और आपके कोड फिर से स्वीकार होंगे। केवल आपकी डिवाइस घड़ी ठीक करने की ज़रूरत है; कोड स्वयं ऑफ़लाइन ही बनते हैं।',
    },
    {
      question: 'एल्गोरिदम/अंक/अवधि में क्या अंतर है?',
      answer: 'ये उन्नत सेटिंग्स हैं (आमतौर पर डिफॉल्ट काम करते हैं):\n\n• एल्गोरिदम: कोड बनाने में उपयोग होने वाला हैश फ़ंक्शन (SHA1 मानक है)\n• अंक: कोड की लंबाई (6 सबसे आम है, कुछ 8 का उपयोग करते हैं)\n• अवधि: कोड कितने समय तक वैध हैं (30 सेकंड मानक)\n\nअधिकांश सेवाएँ उपयोग करती हैं: SHA1, 6 अंक, 30 सेकंड।',
    },
    {
      question: 'क्या मेरा डेटा सुरक्षित है?',
      answer: 'आपके खाते केवल आपके डिवाइस पर रहते हैं। हमारे पास कोई सर्वर नहीं है और हमें आपका डेटा कभी नहीं मिलता।\n\n• गुप्त कुंजियाँ कभी आपके डिवाइस से बाहर नहीं जातीं\n• कुछ गड़बड़ होने की स्थिति के लिए स्वचालित स्थानीय बैकअप (अंतिम 7)\n• Chrome स्टोरेज में सहेजा जाता है, सिंक वैकल्पिक दूसरी प्रति के रूप में\n\nडिफ़ॉल्ट रूप से आपके कोड बिना एन्क्रिप्शन के सहेजे जाते हैं और आपके कंप्यूटर लॉगिन तथा Chrome प्रोफ़ाइल से सुरक्षित रहते हैं — जैसा अधिकांश ऑथेंटिकेटर एक्सटेंशन में होता है। अधिक मज़बूत सुरक्षा के लिए सेटिंग्स में पासवर्ड सुरक्षा चालू करें: तब आपके कोड, बैकअप सहित, आपके डिवाइस पर एन्क्रिप्ट हो जाते हैं और आपके पासवर्ड के बिना पढ़े नहीं जा सकते।',
    },
    {
      id: 'password-protection',
      question: 'मैं अपने कोड को पासवर्ड से कैसे सुरक्षित करूँ?',
      answer: 'सेटिंग्स खोलें और "पासवर्ड सुरक्षा" चालू करें। इसके बाद आपके कोड इस डिवाइस पर एन्क्रिप्ट हो जाते हैं, और पासवर्ड के बिना उन्हें कोई नहीं पढ़ सकता — न आपका कंप्यूटर इस्तेमाल करने वाला कोई व्यक्ति, न ब्राउज़र डेटा चुराने वाला वायरस, और न ही आपके Google खाते के सिंक के ज़रिए।\n\nआपको एक रिकवरी कोड भी मिलेगा। उसे इस ब्राउज़र से बाहर कहीं सहेजें: पासवर्ड भूल जाने पर वापस आने का यही एकमात्र रास्ता है। हम उसे आपके लिए रीसेट नहीं कर सकते।\n\nआप तय करते हैं कि पासवर्ड कितनी बार पूछा जाए: हर बार, कुछ मिनट निष्क्रिय रहने के बाद, या ब्राउज़र बंद होने तक एक बार। आप अपने पासवर्ड से यह सुरक्षा कभी भी बंद कर सकते हैं।',
    },
    {
      question: 'क्या मैं Google Authenticator से आयात कर सकता/सकती हूँ?',
      answer: 'हाँ! Google Authenticator में एक्सपोर्ट सुविधा है:\n\n1. Google Authenticator ऐप खोलें\n2. "खाते स्थानांतरित करें" → "खाते एक्सपोर्ट करें" पर टैप करें\n3. एक्सपोर्ट करने के लिए खाते चुनें\n4. QR Code का स्क्रीनशॉट लें\n5. इस ऐप में: खाता जोड़ें → QR Code → स्क्रीनशॉट अपलोड करें',
    },
    {
      question: 'यदि मैं अपना बैकअप खो दूँ तो क्या होगा?',
      answer: 'यदि आप इस एक्सटेंशन तक पहुँच खो देते हैं और कोई बैकअप नहीं है:\n\n1. आपको प्रत्येक प्रभावित सेवा पर 2FA अक्षम करना होगा\n2. फिर 2FA पुनः सक्षम करें और खाते दोबारा जोड़ें\n3. सेवाओं के रिकवरी कोड सुरक्षित स्थान पर रखें\n\nरोकथाम: नियमित रूप से बैकअप एक्सपोर्ट करें और उन्हें सुरक्षित रूप से संग्रहीत करें!',
    },
  ],
  ar: [
    {
      question: 'كيف أضيف حسابًا جديدًا؟',
      answer: 'يمكنك إضافة حساب بطريقتين:\n\n1. الإدخال اليدوي: انقر على "إضافة حساب"، أدخل اسم الحساب والمفتاح السري من صفحة إعداد 2FA لخدمتك.\n\n2. QR Code: انقر على "إضافة حساب"، انتقل إلى علامة تبويب "QR Code"، وارفع لقطة شاشة أو صورة لـ QR Code المعروض أثناء إعداد 2FA.',
    },
    {
      question: 'أين أجد المفتاح السري؟',
      answer: 'عند إعداد 2FA على أي خدمة (Gmail، GitHub، إلخ):\n\n1. ابحث عن رابط "لا يمكنك مسح QR Code؟" أو "الإدخال يدويًا"\n2. انقر عليه لإظهار المفتاح السري\n3. المفتاح عادةً 16-32 حرفًا (الأحرف A-Z والأرقام 2-7)\n4. مثال: JBSWY3DPEHPK3PXP',
    },
    {
      question: 'لماذا لا تعمل رموزي؟',
      answer: 'إذا تم رفض الرموز، فإن السبب الأكثر شيوعًا هو مزامنة الوقت:\n\n• يجب أن تكون ساعة جهاز الكمبيوتر دقيقة (في حدود 30 ثانية)\n• رموز TOTP تعتمد على الوقت وتنتهي صلاحيتها كل 30 ثانية\n• تحقق مما إذا كنت ترى تحذير الوقت في أعلى التطبيق\n• الحل: حدّث وقت النظام أو فعّل المزامنة التلقائية للوقت',
    },
    {
      question: 'كيف أنشئ نسخة احتياطية لحساباتي؟',
      answer: 'لإنشاء نسخة احتياطية لحساباتك:\n\n1. انقر على أيقونة الإعدادات (الترس)\n2. انقر على زر "تصدير"\n3. اختر طريقة حفظ الملف:\n\n• محمي بكلمة مرور (موصى به) — الملف عديم الفائدة لمن لا يعرف كلمة المرور. تذكّرها: لا يمكن فتح الملف بدونها.\n• ملف عادي — يقرؤه أي شخص يفتحه. فقط لمكان تتحكم فيه بالكامل.\n\nالتصدير العادي يحتوي على مفاتيحك السرية بنص واضح. أي شخص لديه هذا الملف يمكنه توليد رموز 2FA الخاصة بك.',
    },
    {
      question: 'كيف أستعيد من نسخة احتياطية؟',
      answer: 'لاستعادة الحسابات من نسخة احتياطية:\n\n1. انقر على "استيراد من نسخة احتياطية" على الشاشة الرئيسية\n2. حدد ملف JSON الاحتياطي الخاص بك\n3. سيتم استيراد جميع الحسابات\n\nملاحظة: سيتم إضافة الحسابات إلى حساباتك الحالية، وليس استبدالها.',
    },
    {
      question: 'هل يمكنني استخدامه على أجهزة متعددة؟',
      answer: 'نعم! إذا قمت بتفعيل Chrome Sync:\n\n• ستتم مزامنة حساباتك عبر جميع متصفحات Chrome الخاصة بك\n• يمكنك أيضًا التصدير والاستيراد يدويًا على أجهزة مختلفة\n• ملاحظة: يُستخدم التخزين المحلي أيضًا كنسخة احتياطية',
    },
    {
      question: 'ماذا لو حذفت حسابًا بالخطأ؟',
      answer: 'إذا حذفت حسابًا بالخطأ:\n\n1. تحقق من النسخ الاحتياطية التلقائية (مخزنة لمدة 7 أيام)\n2. أو استعد من ملف النسخة الاحتياطية اليدوية\n3. إذا لم توجد نسخة احتياطية، ستحتاج إلى تعطيل وإعادة تفعيل 2FA على تلك الخدمة\n\nنصيحة: قم دائمًا بتصدير نسخة احتياطية قبل إجراء تغييرات كبيرة!',
    },
    {
      id: 'time-sync',
      question: 'لماذا أرى تحذير مزامنة الوقت؟ وكيف أصلحه؟',
      answer: 'يتم إنشاء رموز TOTP من ساعة جهازك، لذا إذا انحرفت أكثر من ~30 ثانية عن الوقت الحقيقي، فسترفض الخدمات رموزك.\n\nكيفية الإصلاح:\n\n• macOS: إعدادات النظام → عام → التاريخ والوقت → فعّل "ضبط الوقت والتاريخ تلقائيًا"\n• Windows: الإعدادات → الوقت واللغة → التاريخ والوقت → فعّل "ضبط الوقت تلقائيًا" ثم انقر "المزامنة الآن"\n• Linux: فعّل NTP / التاريخ والوقت التلقائي في الإعدادات\n\nبعد المزامنة، أعد فتح الإضافة — يختفي التحذير وتُقبل رموزك من جديد. ساعة جهازك فقط هي ما يحتاج للإصلاح؛ أما الرموز نفسها فتُنشأ دون اتصال.',
    },
    {
      question: 'ما الفرق بين الخوارزمية/الأرقام/الفترة؟',
      answer: 'هذه إعدادات متقدمة (عادةً الإعدادات الافتراضية تعمل):\n\n• الخوارزمية: دالة التجزئة المستخدمة لتوليد الرمز (SHA1 هو المعيار)\n• الأرقام: طول الرمز (6 هو الأكثر شيوعًا، بعضها يستخدم 8)\n• الفترة: مدة صلاحية الرموز (30 ثانية قياسي)\n\nمعظم الخدمات تستخدم: SHA1، 6 أرقام، 30 ثانية.',
    },
    {
      question: 'هل بياناتي آمنة؟',
      answer: 'حساباتك موجودة على جهازك فقط. ليس لدينا خوادم ولا نتلقى بياناتك أبدًا.\n\n• المفاتيح السرية لا تغادر جهازك أبدًا\n• نسخ احتياطية محلية تلقائية (آخر 7) تحسبًا لأي خلل\n• تُحفظ في تخزين Chrome، مع المزامنة كنسخة ثانية اختيارية\n\nافتراضيًا تُحفظ رموزك دون تشفير، محميةً بتسجيل الدخول إلى حاسوبك وملف تعريف Chrome — مثل معظم إضافات المصادقة. للحصول على حماية أقوى، فعّل الحماية بكلمة مرور من الإعدادات: عندها تُشفَّر رموزك على جهازك، بما في ذلك النسخ الاحتياطية، ولا يمكن قراءتها بدون كلمة المرور.',
    },
    {
      id: 'password-protection',
      question: 'كيف أحمي رموزي بكلمة مرور؟',
      answer: 'افتح الإعدادات وفعّل "الحماية بكلمة مرور". عندها تُشفَّر رموزك على هذا الجهاز، فلا يستطيع أحد قراءتها بدون كلمة المرور — لا من يستخدم حاسوبك، ولا فيروس يسرق بيانات المتصفح، ولا عبر مزامنة حساب Google الخاص بك.\n\nستحصل أيضًا على رمز استرداد. احفظه خارج هذا المتصفح: فهو السبيل الوحيد للعودة إذا نسيت كلمة المرور. لا يمكننا إعادة تعيينها لك.\n\nأنت تختار عدد مرات طلب كلمة المرور: في كل مرة، بعد دقائق من الخمول، أو مرة واحدة حتى إغلاق المتصفح. يمكنك إيقاف الحماية في أي وقت بكلمة المرور.',
    },
    {
      question: 'هل يمكنني الاستيراد من Google Authenticator؟',
      answer: 'نعم! Google Authenticator لديه ميزة التصدير:\n\n1. افتح تطبيق Google Authenticator\n2. انقر على "نقل الحسابات" → "تصدير الحسابات"\n3. حدد الحسابات للتصدير\n4. التقط لقطة شاشة لـ QR Code\n5. في هذا التطبيق: إضافة حساب → QR Code → ارفع لقطة الشاشة',
    },
    {
      question: 'ماذا يحدث إذا فقدت نسختي الاحتياطية؟',
      answer: 'إذا فقدت الوصول إلى هذه الإضافة وليس لديك نسخة احتياطية:\n\n1. ستحتاج إلى تعطيل 2FA على كل خدمة متأثرة\n2. ثم أعد تفعيل 2FA وأضف الحسابات مرة أخرى\n3. احتفظ برموز الاسترداد من الخدمات في مكان آمن\n\nالوقاية: صدّر النسخ الاحتياطية بانتظام وخزّنها بشكل آمن!',
    },
  ],

};

export function getFaqItems(language: Language): FAQItem[] {
  return faqData[language] ?? faqData.en ?? [];
}
