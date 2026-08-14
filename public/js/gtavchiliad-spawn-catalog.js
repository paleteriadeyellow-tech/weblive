/**
 * Catálogo de efectos Livecoins Chiliad (plugin propio HTTP :6723).
 * Imágenes remotas vía dashboard (sin peso en el .exe).
 * Todos los effectId de esta lista están implementados en ALivecoinsGtavChiliad.dll
 * (ver bridges/gtavchiliad-http/LivecoinsGtavChiliad.cs → switch Process).
 */
window.GTAVCHILIAD_SPAWN_ENTRIES = [
  // Modo Chiliad
  { id: 'chiliad:chiliad_start', effectId: 'chiliad_start', emoji: '🏔️', nombre: 'Iniciar Chiliad', section: 'mode', imageUrl: 'https://static.wikia.nocookie.net/gtawiki/images/4/42/MountChiliad-IngameGPS-GTAV-Map.png/revision/latest/scale-to-width-down/200?cb=20200301225029', desc: 'Chiliad · Te pone en la base (teleférico abajo) y empieza el reto 20:00 hacia la cima' },
  { id: 'chiliad:chiliad_stop', effectId: 'chiliad_stop', emoji: '🛑', nombre: 'Detener Chiliad', section: 'mode', desc: 'Chiliad · Detiene el reto en curso' },
  { id: 'chiliad:chiliad_timer:+60', effectId: 'chiliad_timer:+60', emoji: '⏱️', nombre: 'Timer +60s', section: 'mode', desc: 'Chiliad · Suma 60 segundos al cronómetro' },
  { id: 'chiliad:chiliad_timer:-60', effectId: 'chiliad_timer:-60', emoji: '⏳', nombre: 'Timer -60s', section: 'mode', desc: 'Chiliad · Resta 60 segundos al cronómetro' },
  { id: 'chiliad:chiliad_gps', effectId: 'chiliad_gps', emoji: '🧭', nombre: 'Apagar GPS', section: 'mode', desc: 'Chiliad · Apaga el GPS unos segundos' },

  // Vehículos (sin caer del cielo: no spawn_random_vehicle / spawn_random_bike / spawn_vehicle:*)
  { id: 'chiliad:spawn_ramp', effectId: 'spawn_ramp', emoji: '🛠️', nombre: 'Spawn Rampa', section: 'vehicles', vehicleModel: 'dune4', desc: 'Chiliad · Coloca una rampa de salto frente al jugador' },
  { id: 'chiliad:drive_random_vehicle', effectId: 'drive_random_vehicle', emoji: '🚙', nombre: 'Conducir vehículo aleatorio', section: 'vehicles', vehicleModel: 'futo', desc: 'Chiliad · Sin coche te sube a uno; si ya vas en uno, lo cambia (no deja el viejo)' },
  { id: 'chiliad:remove_spawned_vehicles', effectId: 'remove_spawned_vehicles', emoji: '🧹', nombre: 'Quitar vehículos spawneados', section: 'vehicles', desc: 'Chiliad · Elimina los vehículos generados por Chiliad' },

  // Atacantes
  { id: 'chiliad:spawn_attackers:3', effectId: 'spawn_attackers:3', emoji: '🧍', nombre: 'Atacantes x3', section: 'attackers', pedModel: 'g_m_y_ballaeast_01', desc: 'Chiliad · Aparecen 3 atacantes desarmados' },
  { id: 'chiliad:spawn_armed_attackers:3', effectId: 'spawn_armed_attackers:3', emoji: '🔫', nombre: 'Atacantes armados x3', section: 'attackers', pedModel: 'g_m_y_ballaeast_01', desc: 'Chiliad · Aparecen 3 atacantes armados' },
  { id: 'chiliad:arm_attackers', effectId: 'arm_attackers', emoji: '🔩', nombre: 'Armar atacantes', section: 'attackers', weaponModel: 'weapon_pistol', desc: 'Chiliad · Da armas a los atacantes existentes' },
  { id: 'chiliad:remove_attackers', effectId: 'remove_attackers', emoji: '🧹', nombre: 'Quitar atacantes', section: 'attackers', desc: 'Chiliad · Elimina a todos los atacantes' },
  { id: 'chiliad:spawn_monkeys:3', effectId: 'spawn_monkeys:3', emoji: '🐒', nombre: 'Monos asesinos x3', section: 'attackers', pedModel: 'a_c_chimp', desc: 'Chiliad · 3 monos hostiles (melee, te atacan)' },
  { id: 'chiliad:moto_cops:2', effectId: 'moto_cops:2', emoji: '🚔', nombre: 'Policías en moto x2', section: 'attackers', pedModel: 's_m_y_cop_01', desc: 'Chiliad · 2 policías en moto persiguen al jugador' },
  { id: 'chiliad:moto_bandits:2', effectId: 'moto_bandits:2', emoji: '🏍️', nombre: 'Bandidos en moto x2', section: 'attackers', pedModel: 'g_m_y_lost_01', desc: 'Chiliad · 2 bandidos en moto persiguen al jugador' },
  { id: 'chiliad:angry_cop', effectId: 'angry_cop', emoji: '👮', nombre: 'Policía enfadado', section: 'attackers', pedModel: 's_m_y_cop_01', desc: 'Chiliad · Aparece un policía enfadado' },
  { id: 'chiliad:extremely_angry_cop', effectId: 'extremely_angry_cop', emoji: '🚨', nombre: 'Policía extremadamente enfadado', section: 'attackers', pedModel: 's_m_y_swat_01', desc: 'Chiliad · Aparece un SWAT muy enfadado' },

  // Armas
  { id: 'chiliad:give_rpg', effectId: 'give_rpg', emoji: '🚀', nombre: 'Dar RPG', section: 'weapons', weaponModel: 'weapon_rpg', desc: 'Chiliad · Da un RPG al jugador' },
  { id: 'chiliad:give_sniper', effectId: 'give_sniper', emoji: '🎯', nombre: 'Dar rifle de precisión', section: 'weapons', weaponModel: 'weapon_sniperrifle', desc: 'Chiliad · Da un rifle de precisión al jugador' },
  { id: 'chiliad:give_random_weapon', effectId: 'give_random_weapon', emoji: '🎲', nombre: 'Arma aleatoria', section: 'weapons', weaponModel: 'weapon_carbinerifle', desc: 'Chiliad · Da un arma aleatoria al jugador' },
  { id: 'chiliad:set_ammo:250', effectId: 'set_ammo:250', emoji: '🔋', nombre: 'Munición x250', section: 'weapons', weaponModel: 'weapon_smg', desc: 'Chiliad · Pone 250 balas al arma actual' },

  // Jugador
  { id: 'chiliad:add_health:100', effectId: 'add_health:100', emoji: '❤️', nombre: '+100 Vida', section: 'player', desc: 'Chiliad · Suma 100 de vida y armadura' },
  { id: 'chiliad:add_money:1000', effectId: 'add_money:1000', emoji: '💵', nombre: '+$1000', section: 'player', imageUrl: 'https://static.wikia.nocookie.net/gtawiki/images/0/01/Money-GTAO-Counter.png/revision/latest/scale-to-width-down/200?cb=20240119032031', desc: 'Chiliad · Suma $1000 al jugador' },
  { id: 'chiliad:set_money:0', effectId: 'set_money:0', emoji: '💸', nombre: 'Vaciar dinero', section: 'player', imageUrl: 'https://static.wikia.nocookie.net/gtawiki/images/0/01/Money-GTAO-Counter.png/revision/latest/scale-to-width-down/200?cb=20240119032031', desc: 'Chiliad · Deja el dinero del jugador en $0' },
  { id: 'chiliad:kill_player', effectId: 'kill_player', emoji: '☠️', nombre: 'Matar al jugador', section: 'player', desc: 'Chiliad · Mata al jugador' },
  { id: 'chiliad:leave_car', effectId: 'leave_car', emoji: '🚪', nombre: 'Salir del vehículo', section: 'player', desc: 'Chiliad · Obliga al jugador a bajar del vehículo' },
  { id: 'chiliad:skydive', effectId: 'skydive', emoji: '🪂', nombre: 'Paracaídas', section: 'player', imageUrl: 'https://static.wikia.nocookie.net/gtawiki/images/d/d4/Parachute-TBoGT.png/revision/latest/scale-to-width-down/148?cb=20240922020544', desc: 'Chiliad · Lanza al jugador al aire con paracaídas' },
  { id: 'chiliad:teleport_up', effectId: 'teleport_up', emoji: '⬆️', nombre: 'Lanzar hacia arriba', section: 'player', desc: 'Chiliad · Impulsa al jugador hacia arriba' },
  { id: 'chiliad:jump', effectId: 'jump', emoji: '🦵', nombre: 'Saltar', section: 'player', desc: 'Chiliad · Hace saltar al jugador' },
  { id: 'chiliad:drunk', effectId: 'drunk', emoji: '🍺', nombre: 'Emborrachar', section: 'player', desc: 'Chiliad · Emborracha al jugador temporalmente' },
  { id: 'chiliad:invincible:30', effectId: 'invincible:30', emoji: '🛡️', nombre: 'Invencible 30s', section: 'player', desc: 'Chiliad · Jugador invencible durante 30 segundos' },
  { id: 'chiliad:random_clothes', effectId: 'random_clothes', emoji: '👕', nombre: 'Ropa aleatoria', section: 'player', desc: 'Chiliad · Cambia la ropa del jugador al azar' },
  { id: 'chiliad:player_poodle', effectId: 'player_poodle', emoji: '🐩', nombre: 'Transformar en caniche', section: 'player', pedModel: 'a_c_poodle', desc: 'Chiliad · Convierte al jugador en caniche' },
  { id: 'chiliad:player_pigeon', effectId: 'player_pigeon', emoji: '🐦', nombre: 'Transformar en paloma', section: 'player', pedModel: 'a_c_pigeon', desc: 'Chiliad · Convierte al jugador en paloma' },
  { id: 'chiliad:player_random_animal', effectId: 'player_random_animal', emoji: '🐾', nombre: 'Animal aleatorio', section: 'player', desc: 'Chiliad · Convierte al jugador en un animal aleatorio' },
  { id: 'chiliad:player_human', effectId: 'player_human', emoji: '👤', nombre: 'Volver a humano', section: 'player', desc: 'Chiliad · Vuelve a tu personaje (también automático al morir como animal)' },
  { id: 'chiliad:ignite_player', effectId: 'ignite_player', emoji: '🔥', nombre: 'Prender fuego al jugador', section: 'player', desc: 'Chiliad · Prende fuego al jugador' },
  { id: 'chiliad:never_wanted', effectId: 'never_wanted', emoji: '😇', nombre: 'Nunca buscado', section: 'player', desc: 'Chiliad · Sin estrellas durante 60s (luego vuelve la búsqueda normal)' },
  { id: 'chiliad:increase_wanted', effectId: 'increase_wanted', emoji: '⭐', nombre: 'Subir nivel de búsqueda', section: 'player', desc: 'Chiliad · Sube una estrella de búsqueda' },
  { id: 'chiliad:plus2stars', effectId: 'plus2stars', emoji: '⭐⭐', nombre: '+2 estrellas', section: 'player', desc: 'Chiliad · Suma dos estrellas de búsqueda' },
  { id: 'chiliad:max_wanted', effectId: 'max_wanted', emoji: '🚨', nombre: 'Máxima búsqueda', section: 'player', desc: 'Chiliad · Pone 5 estrellas de búsqueda' },
  { id: 'chiliad:decrease_wanted', effectId: 'decrease_wanted', emoji: '🔽', nombre: 'Bajar nivel de búsqueda', section: 'player', desc: 'Chiliad · Reduce una estrella de búsqueda' },
  { id: 'chiliad:remove_all_weapons_nearby', effectId: 'remove_all_weapons_nearby', emoji: '🚫', nombre: 'Desarmar a todos', section: 'player', desc: 'Chiliad · Quita las armas a los NPC cercanos' },

  // Efectos de vehículos
  { id: 'chiliad:repair_vehicle', effectId: 'repair_vehicle', emoji: '🔧', nombre: 'Reparar vehículo', section: 'vehiclefx', desc: 'Chiliad · Repara tu vehículo actual' },
  { id: 'chiliad:explode_vehicles', effectId: 'explode_vehicles', emoji: '💥', nombre: 'Explotar vehículo', section: 'vehiclefx', desc: 'Chiliad · Explota tu vehículo actual' },
  { id: 'chiliad:launch_vehicles', effectId: 'launch_vehicles', emoji: '🚀', nombre: 'Lanzar vehículo', section: 'vehiclefx', desc: 'Chiliad · Lanza al aire tu vehículo actual' },
  { id: 'chiliad:kill_engines', effectId: 'kill_engines', emoji: '🛑', nombre: 'Apagar motor', section: 'vehiclefx', desc: 'Chiliad · Apaga el motor de tu vehículo' },
  { id: 'chiliad:dismantle_vehicle', effectId: 'dismantle_vehicle', emoji: '🔩', nombre: 'Desmontar vehículo', section: 'vehiclefx', desc: 'Chiliad · Rompe puertas/ventanas de tu vehículo' },
  { id: 'chiliad:brake_wheels', effectId: 'brake_wheels', emoji: '🛞', nombre: 'Pinchar ruedas', section: 'vehiclefx', desc: 'Chiliad · Pincha las ruedas de tu vehículo' },
  { id: 'chiliad:delete_player_vehicle', effectId: 'delete_player_vehicle', emoji: '🗑️', nombre: 'Eliminar vehículo actual', section: 'vehiclefx', desc: 'Chiliad · Borra tu vehículo actual' },
  { id: 'chiliad:invisible_vehicles', effectId: 'invisible_vehicles', emoji: '👻', nombre: 'Vehículo invisible', section: 'vehiclefx', desc: 'Chiliad · Vuelve invisible tu vehículo' },
  { id: 'chiliad:fast_cars', effectId: 'fast_cars', emoji: '🏎️', nombre: 'Auto veloz', section: 'vehiclefx', desc: 'Chiliad · Aumenta la velocidad de tu vehículo' },
  { id: 'chiliad:random_tuning', effectId: 'random_tuning', emoji: '🎨', nombre: 'Tuning aleatorio', section: 'vehiclefx', desc: 'Chiliad · Tuning aleatorio en tu vehículo' },
  { id: 'chiliad:full_tuning', effectId: 'full_tuning', emoji: '✨', nombre: 'Tuning completo', section: 'vehiclefx', desc: 'Chiliad · Tuning máximo en tu vehículo' },
  { id: 'chiliad:nitro:3', effectId: 'nitro:3', emoji: '🔥', nombre: 'Nitro 3s', section: 'vehiclefx', desc: 'Chiliad · Nitro 3s en tu vehículo' },
  { id: 'chiliad:engine_x2', effectId: 'engine_x2', emoji: '⚡', nombre: 'Motor x2', section: 'vehiclefx', desc: 'Chiliad · Duplica la potencia de tu motor' },
  { id: 'chiliad:nogravity', effectId: 'nogravity', emoji: '🛸', nombre: 'Sin gravedad', section: 'vehiclefx', desc: 'Chiliad · Tu vehículo flota sin gravedad' },
  { id: 'chiliad:enter_nearest_vehicle', effectId: 'enter_nearest_vehicle', emoji: '🚘', nombre: 'Entrar al vehículo más cercano', section: 'vehiclefx', desc: 'Chiliad · Mete al jugador en el vehículo más cercano' },
  { id: 'chiliad:everyone_exit_vehicles', effectId: 'everyone_exit_vehicles', emoji: '🚪', nombre: 'Todos bajan de sus vehículos', section: 'vehiclefx', desc: 'Chiliad · Obliga a los NPC cercanos a bajar de sus vehículos' },

  // Mundo y clima
  { id: 'chiliad:time_morning', effectId: 'time_morning', emoji: '🌅', nombre: 'Hora: Mañana', section: 'world', desc: 'Chiliad · Cambia la hora a la mañana' },
  { id: 'chiliad:time_day', effectId: 'time_day', emoji: '☀️', nombre: 'Hora: Día', section: 'world', desc: 'Chiliad · Cambia la hora al mediodía' },
  { id: 'chiliad:time_afternoon', effectId: 'time_afternoon', emoji: '🌇', nombre: 'Hora: Tarde', section: 'world', desc: 'Chiliad · Cambia la hora a la tarde' },
  { id: 'chiliad:time_night', effectId: 'time_night', emoji: '🌙', nombre: 'Hora: Noche', section: 'world', desc: 'Chiliad · Cambia la hora a la medianoche' },
  { id: 'chiliad:weather_sunny', effectId: 'weather_sunny', emoji: '☀️', nombre: 'Clima soleado', section: 'world', desc: 'Chiliad · Pone el clima extra soleado' },
  { id: 'chiliad:weather_foggy', effectId: 'weather_foggy', emoji: '🌫️', nombre: 'Clima con niebla', section: 'world', desc: 'Chiliad · Pone niebla' },
  { id: 'chiliad:weather_clear', effectId: 'weather_clear', emoji: '🌤️', nombre: 'Clima despejado', section: 'world', desc: 'Chiliad · Despeja el clima' },
  { id: 'chiliad:weather_snowy', effectId: 'weather_snowy', emoji: '❄️', nombre: 'Clima nevado', section: 'world', desc: 'Chiliad · Pone nieve' },
  { id: 'chiliad:weather_stormy', effectId: 'weather_stormy', emoji: '⛈️', nombre: 'Clima tormentoso', section: 'world', desc: 'Chiliad · Pone tormenta' },
  { id: 'chiliad:earthquake', effectId: 'earthquake', emoji: '🌋', nombre: 'Terremoto', section: 'world', desc: 'Chiliad · Sacude la cámara y lanza a los peatones cercanos' },
  { id: 'chiliad:black_hole', effectId: 'black_hole', emoji: '🕳️', nombre: 'Agujero negro', section: 'world', desc: 'Chiliad · Absorbe vehículos y peatones cercanos' },
  { id: 'chiliad:peds_riot', effectId: 'peds_riot', emoji: '💢', nombre: 'Disturbios de peatones', section: 'world', desc: 'Chiliad · Los peatones cercanos atacan al jugador' },
  { id: 'chiliad:no_phone', effectId: 'no_phone', emoji: '📵', nombre: 'Sin teléfono', section: 'world', desc: 'Chiliad · Destruye el teléfono del jugador' },
  { id: 'chiliad:game_speed_02', effectId: 'game_speed_02', emoji: '🐌', nombre: 'Velocidad del juego x0.2', section: 'world', desc: 'Chiliad · Ralentiza el juego a 0.2x durante unos segundos' },
  { id: 'chiliad:game_speed_05', effectId: 'game_speed_05', emoji: '🐢', nombre: 'Velocidad del juego x0.5', section: 'world', desc: 'Chiliad · Ralentiza el juego a 0.5x durante unos segundos' },
  { id: 'chiliad:traffic_red', effectId: 'traffic_red', emoji: '🔴', nombre: 'Tráfico rojo', section: 'world', desc: 'Chiliad · Pinta el tráfico cercano de rojo' },
  { id: 'chiliad:traffic_blue', effectId: 'traffic_blue', emoji: '🔵', nombre: 'Tráfico azul', section: 'world', desc: 'Chiliad · Pinta el tráfico cercano de azul' },
  { id: 'chiliad:traffic_chrome', effectId: 'traffic_chrome', emoji: '⚙️', nombre: 'Tráfico cromado', section: 'world', desc: 'Chiliad · Pinta el tráfico cercano de cromo' },
  { id: 'chiliad:traffic_hot', effectId: 'traffic_hot', emoji: '🔥', nombre: 'Tráfico llamativo', section: 'world', desc: 'Chiliad · Pinta el tráfico cercano de un color llamativo' },
  { id: 'chiliad:traffic_rainbow', effectId: 'traffic_rainbow', emoji: '🌈', nombre: 'Tráfico arcoíris', section: 'world', desc: 'Chiliad · Pinta el tráfico cercano de colores al azar' },

  // Teletransportes (fotos de GTA Wiki)
  { id: 'chiliad:tp_lsairport', effectId: 'tp_lsairport', emoji: '✈️', nombre: 'Teleport: Aeropuerto de LS', section: 'teleports', imageUrl: 'https://static.wikia.nocookie.net/gtawiki/images/2/25/LosSantosInternationalAirport-IngameGPS-GTAV-Map.png/revision/latest/scale-to-width-down/200?cb=20200206195720', desc: 'Chiliad · Aeropuerto de Los Santos' },
  { id: 'chiliad:tp_mazebanktower', effectId: 'tp_mazebanktower', emoji: '🏙️', nombre: 'Teleport: Maze Bank Tower', section: 'teleports', imageUrl: 'https://static.wikia.nocookie.net/gtawiki/images/a/af/MazeBankTower-GTAV-Overview.png/revision/latest/scale-to-width-down/200?cb=20181012152144', desc: 'Chiliad · Torre Maze Bank' },
  { id: 'chiliad:tp_fortzancudo', effectId: 'tp_fortzancudo', emoji: '🪖', nombre: 'Teleport: Fort Zancudo', section: 'teleports', imageUrl: 'https://static.wikia.nocookie.net/gtawiki/images/7/71/FortZancudo-GTAV-IngameGPS-Map.png/revision/latest/scale-to-width-down/200?cb=20200303172858', desc: 'Chiliad · Base militar Fort Zancudo' },
  { id: 'chiliad:tp_mountchilliad', effectId: 'tp_mountchilliad', emoji: '⛰️', nombre: 'Teleport: Cima del Monte Chiliad', section: 'teleports', imageUrl: 'https://static.wikia.nocookie.net/gtawiki/images/4/42/MountChiliad-IngameGPS-GTAV-Map.png/revision/latest/scale-to-width-down/200?cb=20200301225029', desc: 'Chiliad · Cima del Monte Chiliad' },
  { id: 'chiliad:tp_random', effectId: 'tp_random', emoji: '🎲', nombre: 'Teleport: Aleatorio', section: 'teleports', imageUrl: 'https://static.wikia.nocookie.net/gtawiki/images/4/48/LosSantos-GTAV-Map.jpg/revision/latest/scale-to-width-down/200?cb=20210901121031', desc: 'Chiliad · Lugar aleatorio' },
];
