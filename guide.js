// Creativa CRM — the guide on Settings: everything the CRM does, by area, with how to use it. In English and Spanish
// (whichever the Español button is set to). Each section: a title, what it's for, and the steps.
window.CRM_GUIDE = {
  en: {
    title: 'Guide: everything the CRM does',
    intro: 'Tap a section to open it. The CRM saves as you go; every change shows on Changes with who made it. Tap Español at the top to see the CRM in Spanish.',
    sections: [
      ['Getting around', 'The tabs at the top are the pages. Today is the place to start each morning.', [
        'Today: new website requests, follow-ups due, tours coming up, tours to reschedule, and your to-dos.',
        'Español / English (top right) switches the language on this device. Names and what people type stay as written.',
        'Every list has a search box and filters. Tap any row to open it; Save at the bottom, ✕ or Cancel to close.',
        'On a phone, the tabs scroll sideways and every page fits the screen.']],
      ['Families and tours (Pipeline, All inquiries)', 'Every family that asks about the school, from the website or added by hand, until they enroll or are lost.', [
        'Pipeline: one column per stage (New, Contacted, Tour scheduled, Reschedule, Toured, Waitlisted, Enrolled, Lost). Drag a card, or on a phone use “Move to…”.',
        '+ Add inquiry for a call or walk-in. Open a family to call, text or email them, log a call or a note, and set the next follow-up date.',
        'Tour scheduled needs a date and time. The family gets a reminder email/text the day before and a “how was your visit?” a week after (switch it off per family).',
        'Starts on and Tuition: when a family will start and what they’ll pay, so Money → Projection counts them.',
        'Registration paid on: paying registration is what holds a spot on the waiting list. Waitlisted cards say “registration paid” or “not paid”.',
        'Waitlisted or Enrolled: a button adds the child to the waiting list or the enrollment list in one tap, keeping their start date, rate and registration.',
        'Spam (admins): deletes the inquiry and blocks that email, phone and device.']],
      ['Enrollment', 'Every child: class, status, documents, family contacts, tuition and funding.', [
        'Class cards at the top show how many are enrolled, the capacity, and how many are waiting (and paid registration). Tap a card to filter.',
        'Tick a document (packet, blue form, yellow form, birth certificate) when it comes in; the date is saved.',
        'Print for inspection (on the Whole school card): a numbered checklist of every child enrolled, by last name, with their date of birth and the total at the top.',
        'Out for a while (sick)? Open the child and fill in “Paused until” (the day they’re back): no tuition bills until then (saving offers to take off this period’s unpaid bill); billing starts again by itself.',
        'Open a child: start date, status (Enrolled, Waitlist, Withdrawn, Graduated), last day, contacts (Primary = mother, Secondary = father, Emergency), RBT and therapies.',
        'Funding & tuition: tick the program (FES-UA, FES-EO, SR, VPK, Step Up pending) and pick the class rate from the list: until 3:00 or until 5:45 with after care.',
        'A different rate on purpose (a sibling discount)? Type it and write why under “Why the rate is different”.',
        'Brothers and sisters: “Copy from a brother or sister” copies the parents; the same family account bills them together.',
        'Registration 2027–28 (tab at the top): who’s coming back, the class they move up to, the registration fee, and Record payment (with a receipt). Mark “No” for families not returning.']],
      ['Tuition and payments', 'Tuition is billed every two weeks, on Monday, with grace until Friday.', [
        'Bill this period creates the two-week bills for everyone (children on Step Up pending, with no rate, or not billed to the family are skipped).',
        'Record payment: who paid (parent, FES, SR, VPK), how (cash, check, Zelle, card), and which bill. A payment without a bill stays as a credit.',
        'Each payment has a receipt to print or save as PDF, signed and with the license and tax ID. Print FES-UA receipts prints them for Step Up.',
        'After the Friday grace day, “Add late fees” adds the $30 late fee to unpaid bills. Added by mistake? Tap “take off” next to it.',
        'Owes money / Owed list: who still owes, oldest first. ‹ › moves between periods.']],
      ['Reports', 'Money that came in, by month, and the papers families need.', [
        'Received, billed and still owed in the month; who paid (families, FES, SR, VPK) and how; by class; by funding.',
        'Annual statements: what each family paid in the year, with the school’s tax ID, for their child care tax credit. Print one or all.',
        'Download CSV on any list for Excel or the accountant.']],
      ['Money: in and out, bills, food program, projection', 'Like an accountant: what comes in, what goes out, and what’s coming.', [
        'In & out: each month’s money in (tuition, programs, food program, deposits) and out (payroll, rent, bills, receipts). + Expense to add a receipt or bill paid.',
        'Bills: rent (twice a month), FPL and every bill paid on set days. Mark paid when you pay one; unpaid ones show under “On its way”.',
        'Food program: each month’s claim (meals, costs, submitted, paid) and the Monthly Record of Operating Expenditures to print, from the receipts marked for it.',
        'Projection: the coming months. What’s left over a month, a chart of money in and out, a card per month (with what came in so far this month), new families, and rates to check.']],
      ['Payroll and the time clock', 'Staff clock in and out on the tablet at the front desk; payroll is run in Patriot.', [
        'Staff: each person’s position, hourly rate, lunch and schedule, and their time clock PIN (Show PINs; print slips). People missing a PIN are listed at the top. Paid off = working without pay for now: their time stays off payroll.',
        'Time clock: set up the tablet once (Payroll → Time clock → Use this device). Staff tap their name, type their PIN, and Clock in / Clock out. Nobody clocks out for lunch: their scheduled lunch comes off any day they work more than 6 hours.',
        'Starts at: each person’s start time (on their page in Staff). Clocking in early is saved as that time, so pay starts then; Today shows who’s at work, gone, or not in yet.',
        'Hours: every pay period (two weeks, Friday to Thursday): fix any missed clock-out, then “Hours for Patriot” to type them into Patriot.',
        'After Patriot: add the paychecks (copy the list from Patriot and paste it), then “Mark as entered in Patriot” to lock the period.',
        'The step-by-step guide for payroll and pay stubs is on the Payroll page.']],
      ['Messages to families', 'Texts to one family, a class, a list, or everyone (needs the texting service connected).', [
        'Start from a saved message or write your own; blocks like {parent}, {child} and {balance} are filled in for each family. Check each text before sending.',
        'Lists (like TextMagic): FES moms, Kinder moms, 1st floor, 2nd floor, VPK… kept up to date from each child’s class and funding.',
        'Families missing paperwork and families with a late balance are ready-made lists.']],
      ['To do and reminders', 'What the office has to do, with reminders on Today.', [
        '+ New to-do: what, who it’s for, when it’s due, whether it repeats, and how many days before to remind.',
        'The food program claim and the SR and VPK attendance are due the 1st of every month, reminded a week before.',
        'Check one off when it’s done; a repeating one comes back for its next date.']],
      ['Changes', 'Who changed what, newest first.', [
        'Children and contacts, tuition and payments, payroll and time, settings and access. New changes by others are counted on the tab.',
        'Each child’s page also shows their recent changes.']],
      ['Settings (admins)', 'How the CRM is set up.', [
        'Staff: who can sign in, their role, and access to finances and payroll.',
        'Classes: teachers, capacity, and the tuition rates (full time until 3:00, with after care until 5:45; Kindergarten by school year).',
        'School calendar: holidays and closed days, and whether staff are paid (one week of winter break isn’t). Families pay full tuition through them.',
        'Receipts: school name, who signs, license, tax ID, address and the signature printed on receipts.',
        'Tour emails and texts, the tour calendar link for Google Calendar, Telegram alerts for new requests, and spam protection.']],
    ],
  },
  es: {
    title: 'Guía: todo lo que hace el CRM',
    intro: 'Toque una sección para abrirla. El CRM guarda solo; cada cambio aparece en Cambios con quién lo hizo. Toque English arriba para ver el CRM en inglés.',
    sections: [
      ['Cómo moverse', 'Las pestañas de arriba son las páginas. Hoy es donde empezar cada mañana.', [
        'Hoy: solicitudes nuevas del sitio web, seguimientos pendientes, próximas visitas, visitas por reprogramar y sus pendientes.',
        'Español / English (arriba a la derecha) cambia el idioma en este aparato. Los nombres y lo que la gente escribe quedan igual.',
        'Cada lista tiene un buscador y filtros. Toque una fila para abrirla; Guardar abajo, ✕ o Cancelar para cerrar.',
        'En el teléfono, las pestañas se deslizan de lado y cada página cabe en la pantalla.']],
      ['Familias y visitas (Embudo, Todas las consultas)', 'Cada familia que pregunta por la escuela, por el sitio web o agregada a mano, hasta que se inscribe o se pierde.', [
        'Embudo: una columna por etapa (Nueva, Contactada, Visita programada, Reprogramar, Visitó, En lista de espera, Inscrito, Perdida). Arrastre la tarjeta, o en el teléfono use “Mover a…”.',
        '+ Agregar consulta para una llamada o alguien que llega. Abra una familia para llamar, enviar texto o correo, anotar una llamada o nota, y poner la fecha del próximo seguimiento.',
        'Visita programada necesita fecha y hora. La familia recibe un recordatorio el día antes y un “¿cómo le fue en la visita?” una semana después (se puede apagar por familia).',
        'Empieza el y Matrícula: cuándo empezará y cuánto pagará, para que Dinero → Proyección la cuente.',
        'Matrícula pagada el: pagar la matrícula es lo que asegura el lugar en la lista de espera. Las tarjetas dicen “matrícula pagada” o “sin pagar”.',
        'En lista de espera o Inscrito: un botón agrega al niño a la lista de espera o de inscritos en un toque, con su fecha de inicio, tarifa y matrícula.',
        'Spam (administradores): elimina la consulta y bloquea ese correo, teléfono y aparato.']],
      ['Inscripción', 'Cada niño: clase, estado, documentos, contactos de la familia, matrícula y fondos.', [
        'Las tarjetas de clase arriba muestran cuántos hay inscritos, la capacidad, y cuántos esperan (y pagaron la matrícula). Toque una para filtrar.',
        'Marque un documento (paquete, formulario azul, amarillo, acta de nacimiento) cuando llegue; se guarda la fecha.',
        'Imprimir para inspección (en la tarjeta Toda la escuela): una lista numerada de todos los niños inscritos, por apellido, con su fecha de nacimiento y el total arriba.',
        '¿Faltará un tiempo (enfermo)? Abra al niño y ponga “En pausa hasta” (el día que regresa): no se cobra matrícula hasta entonces (al guardar, ofrece quitar el cobro sin pagar de este período); el cobro vuelve a empezar solo.',
        'Abra un niño: fecha de inicio, estado (Inscrito, Lista de espera, Retirado, Graduado), último día, contactos (Principal = madre, Secundario = padre, Emergencia), RBT y terapias.',
        'Fondos y matrícula: marque el programa (FES-UA, FES-EO, SR, VPK, Step Up pendiente) y elija la tarifa de la clase en la lista: hasta las 3:00 o hasta las 5:45 con cuidado extendido.',
        '¿Una tarifa diferente a propósito (descuento por hermano)? Escríbala y ponga por qué en “Por qué la tarifa es diferente”.',
        'Hermanos: “Copiar de un hermano o hermana” copia a los padres; la misma cuenta de familia los cobra juntos.',
        'Matrícula 2027–28 (pestaña arriba): quién regresa, la clase a la que pasa, la matrícula y Registrar pago (con recibo). Marque “No” para las familias que no regresan.']],
      ['Matrícula y pagos', 'La matrícula se cobra cada dos semanas, el lunes, con plazo hasta el viernes.', [
        'Cobrar este período crea los cobros de dos semanas para todos (se saltan los de Step Up pendiente, sin tarifa o que no se le cobran a la familia).',
        'Registrar pago: quién pagó (padres, FES, SR, VPK), cómo (efectivo, cheque, Zelle, tarjeta) y qué cobro. Un pago sin cobro queda como crédito.',
        'Cada pago tiene un recibo para imprimir o guardar en PDF, firmado y con la licencia y el número fiscal. Imprimir recibos FES-UA los imprime para Step Up.',
        'Después del viernes de plazo, “Agregar recargos” pone el recargo de $30 a los cobros sin pagar. ¿Se agregó por error? Toque “quitar” al lado.',
        'Debe dinero / lista de lo que se debe: quién debe todavía, lo más viejo primero. ‹ › cambia de período.']],
      ['Informes', 'El dinero que entró, por mes, y los papeles que necesitan las familias.', [
        'Recibido, cobrado y lo que se debe en el mes; quién pagó (familias, FES, SR, VPK) y cómo; por clase; por fondos.',
        'Estados anuales: lo que pagó cada familia en el año, con el número fiscal de la escuela, para su crédito de impuestos por cuidado infantil. Imprima uno o todos.',
        'Descargar CSV en cualquier lista para Excel o el contador.']],
      ['Dinero: entradas y salidas, facturas, programa de alimentos, proyección', 'Como un contador: lo que entra, lo que sale y lo que viene.', [
        'Entradas y salidas: el dinero que entra cada mes (matrícula, programas, alimentos, depósitos) y el que sale (nómina, renta, facturas, recibos). + Gasto para agregar un recibo o una factura pagada.',
        'Facturas: la renta (dos veces al mes), FPL y cada factura que se paga en días fijos. Marcar pagada cuando la pague; las que faltan aparecen en “En camino”.',
        'Programa de alimentos: el reclamo de cada mes (comidas, costos, enviado, pagado) y el Registro Mensual de Gastos para imprimir, con los recibos marcados para el programa.',
        'Proyección: los próximos meses. El sobrante al mes, un gráfico de lo que entra y sale, una tarjeta por mes (con lo que entró hasta ahora este mes), familias nuevas y tarifas por revisar.']],
      ['Nómina y reloj de entrada', 'El personal marca entrada y salida en la tableta de la recepción; la nómina se corre en Patriot.', [
        'Personal: el puesto, pago por hora, almuerzo y horario de cada persona, y su PIN del reloj (Mostrar PIN; imprimir papelitos). Arriba aparecen quienes no tienen PIN. Sin pago = trabaja sin pago por ahora: su tiempo no entra en la nómina.',
        'Reloj: prepare la tableta una vez (Nómina → Reloj → Usar este aparato). Cada persona toca su nombre, escribe su PIN y marca Entrada / Salida. Nadie marca salida para almorzar: su almuerzo programado se descuenta cualquier día que trabaje más de 6 horas.',
        'Entra a las: la hora de entrada de cada persona (en su página en Personal). Si marca antes, se guarda esa hora y el pago empieza ahí; Hoy muestra quién está trabajando, ya se fue o no ha llegado.',
        'Horas: cada período de pago (dos semanas, de viernes a jueves): corrija las salidas que falten y luego “Horas para Patriot” para pasarlas a Patriot.',
        'Después de Patriot: agregue los cheques de pago (copie la lista de Patriot y péguela) y luego “Marcar como pasado a Patriot” para cerrar el período.',
        'La guía paso a paso de la nómina y los talones de pago está en la página de Nómina.']],
      ['Mensajes a las familias', 'Textos a una familia, una clase, una lista o a todos (necesita el servicio de textos conectado).', [
        'Empiece con un mensaje guardado o escriba el suyo; los bloques como {parent}, {child} y {balance} se llenan para cada familia. Revise cada texto antes de enviar.',
        'Listas (como TextMagic): mamás FES, mamás de kínder, primer piso, segundo piso, VPK… se mantienen al día según la clase y los fondos de cada niño.',
        'Las familias a las que les faltan papeles y las que tienen saldo atrasado ya son listas listas para usar.']],
      ['Pendientes y recordatorios', 'Lo que tiene que hacer la oficina, con recordatorios en Hoy.', [
        '+ Nuevo pendiente: qué, para quién, cuándo vence, si se repite y cuántos días antes recordar.',
        'El reclamo del programa de alimentos y la asistencia de SR y VPK vencen el 1 de cada mes, con recordatorio una semana antes.',
        'Márquelo cuando esté hecho; uno que se repite vuelve para su próxima fecha.']],
      ['Cambios', 'Quién cambió qué, lo más nuevo primero.', [
        'Niños y contactos, matrícula y pagos, nómina y tiempo, configuración y acceso. Los cambios nuevos de otros se cuentan en la pestaña.',
        'La página de cada niño también muestra sus cambios recientes.']],
      ['Configuración (administradores)', 'Cómo está preparado el CRM.', [
        'Personal: quién puede entrar, su rol y su acceso a finanzas y nómina.',
        'Clases: maestras, capacidad y las tarifas de matrícula (tiempo completo hasta las 3:00, con cuidado extendido hasta las 5:45; kínder por año escolar).',
        'Calendario escolar: días feriados y cerrados, y si se le paga al personal (una semana de las vacaciones de invierno no). Las familias pagan la matrícula completa igual.',
        'Recibos: nombre de la escuela, quién firma, licencia, número fiscal, dirección y la firma que sale en los recibos.',
        'Correos y textos de visitas, el enlace del calendario de visitas para Google Calendar, avisos de Telegram de solicitudes nuevas y protección contra spam.']],
    ],
  },
};
