import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateConfiguracionDto {
  @ApiProperty({ description: 'Nuevo estado de la bandera' })
  @IsBoolean()
  activa!: boolean;
}
