# Yango Tasks

Dashboard sencillo para gestionar tareas personales y de equipo con roles, categorías, estados editables, múltiples responsables, archivos o links relacionados y tareas recurrentes.

## Roles

- `admin`: ve todo y gestiona usuarios, categorías y tareas.
- `manager`: ve las tareas de su equipo y puede asignar tareas dentro de ese equipo.
- `colaborador`: ve solo su panel y puede crearse tareas asignadas a sí mismo.

Las tareas pueden tener uno o varios responsables. Los colaboradores siguen viendo únicamente tareas donde están asignados.

Las tareas recurrentes pueden repetirse cada 7 días, cada 14 días o una vez al mes. La app crea la copia automáticamente en la próxima fecha laboral y le asigna fecha límite tres días después, ajustada al siguiente día laboral si cae en fin de semana.

Los administradores pueden editar categorías y estados desde la sección `Categorías`. Los estados activos aparecen automáticamente en columnas, filtros, selector de tarea y pildoras de cambio rápido.

## Credenciales demo

```txt
Admin: admin@yango.local / admin123
Manager: manager@yango.local / manager123
Colaborador: ana@yango.local / ana123
```

## Cómo correrlo

```bash
python3 app.py
```

Luego abre:

```txt
http://127.0.0.1:8787/
```

La app usa SQLite y crea `yango_tasks.db` y `uploads/` automáticamente.
