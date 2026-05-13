import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CalculateQuoteDto } from './calculate-quote.dto';

export class ReviseQuoteDto extends CalculateQuoteDto {
  @ApiProperty({ description: 'Razón de la revisión', example: 'Cliente solicitó cambiar avión a Kodiak' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  motivo!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notas?: string;
}
