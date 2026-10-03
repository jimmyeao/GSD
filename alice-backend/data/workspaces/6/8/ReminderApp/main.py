"""Main entry point for the reminder application."""
import sys
import logging
from pathlib import Path

from .mqtt_client import MQTTClient
from .config import Config
from .gui import ReminderAppGUI


def setup_logging():
    """Set up logging configuration."""
    log_dir = Path.home() / ".reminder_app"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / "reminder_app.log"
    
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[
            logging.FileHandler(log_file),
            logging.StreamHandler(sys.stdout)
        ]
    )


def main():
    """Main function to run the reminder application."""
    setup_logging()
    logger = logging.getLogger(__name__)
    
    try:
        # Load configuration
        config = Config()
        logger.info("Configuration loaded")
        
        # Create MQTT client
        mqtt_client = MQTTClient(
            broker=config.mqtt_broker,
            port=config.mqtt_port,
            username=config.mqtt_username,
            password=config.mqtt_password,
            client_id=config.mqtt_client_id,
            base_topic=config.mqtt_base_topic
        )
        
        # Connect to MQTT
        if not mqtt_client.connect():
            logger.error("Failed to connect to MQTT broker. Please check your configuration.")
            input("Press Enter to exit...")
            return 1
        
        logger.info("Connected to MQTT broker successfully")
        
        # Create and run GUI
        app = ReminderAppGUI(mqtt_client)
        app.run()
        
        # Cleanup
        mqtt_client.disconnect()
        logger.info("Application closed")
        
        return 0
    except Exception as e:
        logger.exception(f"Application error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
