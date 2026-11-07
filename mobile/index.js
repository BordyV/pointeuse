import { registerRootComponent } from 'expo';

// Les tâches GPS doivent être déclarées au démarrage, avant l'UI,
// pour que le système puisse réveiller l'app en arrière-plan.
import './src/geo';
import App from './App';

registerRootComponent(App);
